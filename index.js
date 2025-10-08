const express = require('express');
const { MongoClient } = require('mongodb');
const fetch = require('node-fetch');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

// Read version
let VERSION = 'unknown';
try {
  VERSION = fs.readFileSync('/app/VERSION', 'utf8').trim();
} catch (e) {
  // Version file not found
}

// Environment variables
const APP_NAME = process.env.APP_NAME;
const REPLICA_SET_NAME = process.env.MONGO_REPLICA_SET_NAME || 'rs0';
const MONGO_USER = process.env.MONGO_INITDB_ROOT_USERNAME;
const MONGO_PASS = process.env.MONGO_INITDB_ROOT_PASSWORD;
const MONGO_PORT = process.env.MONGO_PORT || '27017';
const RECONCILE_INTERVAL = parseInt(process.env.RECONCILE_INTERVAL || '30000');
const API_PORT = parseInt(process.env.API_PORT || '3000'); // Internal port where API server listens
const EXTERNAL_API_PORT = parseInt(process.env.EXTERNAL_API_PORT || process.env.API_PORT || '3000'); // External port for peer-to-peer communication
const FLUX_API_URL = process.env.FLUX_API_OVERRIDE
  ? `${process.env.FLUX_API_OVERRIDE}/apps/location/${APP_NAME}`
  : `https://api.runonflux.io/apps/location/${APP_NAME}`;

// MongoDB connection URIs
const MONGO_URI_NO_AUTH = `mongodb://localhost:${MONGO_PORT}/?replicaSet=${REPLICA_SET_NAME}&directConnection=true`;
const MONGO_URI_WITH_AUTH = `mongodb://${MONGO_USER}:${MONGO_PASS}@localhost:${MONGO_PORT}/?replicaSet=${REPLICA_SET_NAME}&directConnection=true`;
let mongoClient = null;
let myIP = null;
let myHostname = null;

// Logging
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Get local IP
async function getLocalIP() {
  try {
    const { stdout } = await execAsync("hostname -I | awk '{print $1}'");
    return stdout.trim();
  } catch (error) {
    log(`Error getting local IP: ${error.message}`);
    return null;
  }
}

// Update /etc/hosts with peer hostnames -> IP mappings
async function updateHostsFile(peerIPs) {
  try {
    // Read current /etc/hosts
    let hostsContent = fs.readFileSync('/etc/hosts', 'utf8');
    let modified = false;

    // Add each peer IP with its corresponding hostname
    for (const ip of peerIPs) {
      const hostname = `mongo-${ip.replace(/\./g, '-')}.mongo-cluster`;

      // Check if this hostname already exists
      if (!hostsContent.includes(hostname)) {
        hostsContent += `\n${ip} ${hostname}`;
        log(`Added ${hostname} -> ${ip} to /etc/hosts`);
        modified = true;
      }
    }

    if (modified) {
      fs.writeFileSync('/etc/hosts', hostsContent);
    }
  } catch (error) {
    log(`Error updating /etc/hosts: ${error.message}`);
  }
}

// Fetch all IPs from Flux API (including our own)
async function fetchAllIPs() {
  try {
    const response = await fetch(FLUX_API_URL);
    const data = await response.json();

    if (data.status === 'success' && data.data && data.data.length > 0) {
      const allIPs = data.data
        .map(node => node.ip.split(':')[0])
        .filter(ip => ip)
        .sort();

      log(`Discovered all IPs from Flux API: ${allIPs.join(', ')}`);
      return allIPs;
    }

    log('No nodes found in Flux API');
    return [];
  } catch (error) {
    log(`Error fetching IPs from Flux API: ${error.message}`);
    return [];
  }
}

// Fetch peer IPs from Flux API (excluding our own)
async function fetchPeerIPs() {
  const allIPs = await fetchAllIPs();
  return allIPs.filter(ip => ip !== myIP);
}

// Check if this node can reach itself via hostname (with retries)
async function canReachSelf() {
  const maxRetries = 3;
  const retryDelay = 2000; // 2 seconds between retries

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Use hostname instead of IP for self-reachability check
      // The hostname resolves to 127.0.0.1 (production) or private IP (local testing)
      // Use internal API_PORT for self-check (localhost)
      const response = await fetch(`http://${myHostname}:${API_PORT}/health`, {
        signal: AbortSignal.timeout(5000)
      });

      if (response.ok) {
        if (attempt > 1) {
          log(`Self-reachability check via ${myHostname} succeeded on attempt ${attempt}`);
        }
        return true;
      }
    } catch (error) {
      log(`Self-reachability check via ${myHostname} attempt ${attempt}/${maxRetries} failed: ${error.message}`);

      if (attempt < maxRetries) {
        log(`Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  log(`Self-reachability check via ${myHostname} failed after ${maxRetries} attempts`);
  return false;
}

// Check which peers are reachable
async function getReachablePeers(peerIPs) {
  log('Checking which peer nodes are reachable...');
  const reachable = [];

  for (const peerIP of peerIPs) {
    try {
      // Use EXTERNAL_API_PORT for peer-to-peer communication
      const response = await fetch(`http://${peerIP}:${EXTERNAL_API_PORT}/health`, {
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        reachable.push(peerIP);
        log(`Peer ${peerIP} is reachable`);
      }
    } catch (error) {
      log(`Peer ${peerIP} is unreachable: ${error.message}`);
    }
  }

  log(`Found ${reachable.length}/${peerIPs.length} reachable peers`);
  return reachable;
}

// Check if any peer has an initialized replica set
async function checkPeersForReplicaSet(peerIPs) {
  log('Checking if any peer nodes have an initialized replica set...');

  for (const peerIP of peerIPs) {
    const peerHostname = `mongo-${peerIP.replace(/\./g, '-')}.mongo-cluster`;
    const peerUri = `mongodb://${peerHostname}:${MONGO_PORT}`;

    try {
      log(`Checking peer: ${peerHostname}...`);
      const peerClient = new MongoClient(peerUri, {
        serverSelectionTimeoutMS: 3000,
        connectTimeoutMS: 3000
      });

      await peerClient.connect();

      try {
        const admin = peerClient.db('admin');
        const status = await admin.command({ replSetGetStatus: 1 });

        // If we get here, peer has an initialized replica set
        await peerClient.close();
        log(`Peer ${peerHostname} has an initialized replica set`);
        return true;
      } catch (cmdError) {
        await peerClient.close();
        // NotYetInitialized means no replica set, continue checking
        if (cmdError.codeName !== 'NotYetInitialized') {
          log(`Peer ${peerHostname} error: ${cmdError.message}`);
        }
      }
    } catch (connError) {
      // Can't connect to this peer, skip
      log(`Cannot connect to peer ${peerHostname}: ${connError.message}`);
    }
  }

  log('No peers have an initialized replica set');
  return false;
}

// Check if this node is the leader (lowest reachable IP)
async function isLeader(peerIPs) {
  const allIPs = [myIP, ...peerIPs].sort();

  // Check if we can reach ourselves via hostname - required to be leader
  const selfReachable = await canReachSelf();

  if (!selfReachable) {
    log(`This node (${myHostname}) cannot reach itself via hostname - not eligible for leader`);
    return false;
  }

  log(`This node (${myHostname}) can reach itself via hostname - eligible for leader`);

  // We're eligible - check if we're the lowest IP
  return allIPs[0] === myIP;
}

// Connect to MongoDB (try with auth first, fall back to no auth)
async function connectMongo() {
  // Try with authentication first
  try {
    mongoClient = new MongoClient(MONGO_URI_WITH_AUTH);
    await mongoClient.connect();
    log('Connected to MongoDB with authentication');
    return mongoClient;
  } catch (error) {
    if (error.message.includes('Authentication failed')) {
      log('Authentication failed, trying without auth (localhost exception)...');
      try {
        mongoClient = new MongoClient(MONGO_URI_NO_AUTH);
        await mongoClient.connect();
        log('Connected to MongoDB without authentication (using localhost exception)');
        return mongoClient;
      } catch (noAuthError) {
        log(`MongoDB connection error (no auth): ${noAuthError.message}`);
        return null;
      }
    }
    log(`MongoDB connection error: ${error.message}`);
    return null;
  }
}

// Get replica set status
async function getReplicaSetStatus() {
  try {
    const admin = mongoClient.db('admin');
    const status = await admin.command({ replSetGetStatus: 1 });
    return status;
  } catch (error) {
    if (error.codeName === 'NotYetInitialized') {
      return { notInitialized: true };
    }
    // If authentication is required, replica set exists but we're not authenticated
    if (error.codeName === 'Unauthorized' || error.message.includes('Authentication') || error.message.includes('requires authentication')) {
      return { needsAuth: true };
    }
    throw error;
  }
}

// Check if current node is primary
async function isPrimary() {
  try {
    // Ensure we have a valid connection
    if (!mongoClient || mongoClient.topology?.isConnected() === false) {
      log('MongoDB client disconnected, reconnecting...');
      await connectMongo();
    }

    const admin = mongoClient.db('admin');
    const result = await admin.command({ hello: 1 });
    return result.isWritablePrimary === true;
  } catch (error) {
    log(`Error checking primary status: ${error.message}`);

    // Try to reconnect if connection error
    if (error.message.includes('ECONNREFUSED') || error.message.includes('closed')) {
      log('Attempting to reconnect to MongoDB...');
      try {
        await connectMongo();
      } catch (reconnectError) {
        log(`Failed to reconnect: ${reconnectError.message}`);
      }
    }

    return false;
  }
}

// Create root user after replica set initialization
async function createRootUserAfterInit() {
  if (!MONGO_USER || !MONGO_PASS) {
    log('No MongoDB credentials provided, skipping user creation');
    return false;
  }

  try {
    log('Creating root user after replica set initialization...');
    const admin = mongoClient.db('admin');

    await admin.command({
      createUser: MONGO_USER,
      pwd: MONGO_PASS,
      roles: [{ role: 'root', db: 'admin' }]
    });
    log(`Root user '${MONGO_USER}' created successfully`);

    // Reconnect with authentication
    log('Reconnecting with authentication...');
    await mongoClient.close();
    mongoClient = new MongoClient(MONGO_URI_WITH_AUTH);
    await mongoClient.connect();
    log('Successfully reconnected with authentication');
    return true;
  } catch (error) {
    if (error.codeName === 'DuplicateKey' || error.code === 51003) {
      log('Root user already exists');
      return false;
    }
    log(`Error creating root user: ${error.message}`);
    return false;
  }
}

// Initialize replica set
async function initializeReplicaSet() {
  try {
    const admin = mongoClient.db('admin');

    // Use hostname instead of IP for NAT compatibility
    // The hostname will resolve to localhost for this node, but to public IP for others
    const config = {
      _id: REPLICA_SET_NAME,
      members: [{ _id: 0, host: `${myHostname}:${MONGO_PORT}` }]
    };

    await admin.command({ replSetInitiate: config });
    log(`Replica set initialized with ${myHostname}:${MONGO_PORT}`);

    // Wait for election
    log('Waiting for primary election...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Create root user after replica set is initialized
    await createRootUserAfterInit();

  } catch (error) {
    if (error.codeName === 'AlreadyInitialized') {
      log('Replica set already initialized');
    } else {
      throw error;
    }
  }
}

// Get current replica set configuration
async function getReplicaSetConfig() {
  try {
    const admin = mongoClient.db('admin');
    const result = await admin.command({ replSetGetConfig: 1 });
    return result.config;
  } catch (error) {
    log(`Error getting replica set config: ${error.message}`);
    return null;
  }
}

// Get the latest oplog timestamp from this node
async function getLatestOplogTimestamp() {
  try {
    const local = mongoClient.db('local');
    const oplog = local.collection('oplog.rs');

    // Get the most recent oplog entry
    const latestEntry = await oplog.find().sort({ ts: -1 }).limit(1).toArray();

    if (latestEntry.length > 0) {
      const timestamp = latestEntry[0].ts;
      return {
        timestamp: timestamp,
        time: timestamp.getHighBits(), // Seconds since epoch
        counter: timestamp.getLowBits() // Counter within that second
      };
    }

    return null;
  } catch (error) {
    log(`Error getting oplog timestamp: ${error.message}`);
    return null;
  }
}

// Query peers about who they think is PRIMARY
async function checkPeerPrimaryConsensus(peerIPs) {
  log('Checking peer consensus on PRIMARY...');
  const primaryVotes = new Map(); // Map of hostname -> count
  let reachablePeers = 0;

  for (const peerIP of peerIPs) {
    try {
      // Use EXTERNAL_API_PORT for peer-to-peer communication
      const response = await fetch(`http://${peerIP}:${EXTERNAL_API_PORT}/primary`, {
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        reachablePeers++;
        const data = await response.json();
        const peerThinksPrimary = data.primary; // hostname:port format

        if (peerThinksPrimary) {
          const count = primaryVotes.get(peerThinksPrimary) || 0;
          primaryVotes.set(peerThinksPrimary, count + 1);
          log(`Peer ${peerIP} reports PRIMARY as: ${peerThinksPrimary}`);
        } else {
          log(`Peer ${peerIP} reports no PRIMARY`);
        }
      }
    } catch (error) {
      log(`Cannot reach peer ${peerIP} for consensus check: ${error.message}`);
    }
  }

  return {
    primaryVotes,
    reachablePeers,
    totalPeers: peerIPs.length
  };
}

// Find which node has the most recent data by comparing oplog timestamps
async function findNodeWithLatestData(peerIPs) {
  log('Checking which node has the latest data...');

  const oplogData = new Map(); // Map of IP -> oplog info

  // Get our own oplog timestamp
  const myOplog = await getLatestOplogTimestamp();
  if (myOplog) {
    oplogData.set(myIP, {
      hostname: myHostname,
      time: myOplog.time,
      counter: myOplog.counter
    });
    log(`My oplog timestamp: ${myOplog.time}.${myOplog.counter}`);
  }

  // Query each peer for their oplog timestamp
  for (const peerIP of peerIPs) {
    try {
      // Use EXTERNAL_API_PORT for peer-to-peer communication
      const response = await fetch(`http://${peerIP}:${EXTERNAL_API_PORT}/oplog`, {
        signal: AbortSignal.timeout(3000)
      });

      if (response.ok) {
        const data = await response.json();
        if (data.timestamp) {
          oplogData.set(peerIP, {
            hostname: data.hostname,
            time: data.timestamp.time,
            counter: data.timestamp.counter
          });
          log(`Peer ${peerIP} oplog timestamp: ${data.timestamp.time}.${data.timestamp.counter}`);
        }
      }
    } catch (error) {
      log(`Cannot reach peer ${peerIP} for oplog check: ${error.message}`);
    }
  }

  // Find the node with the highest timestamp
  let latestIP = null;
  let latestHostname = null;
  let latestTime = 0;
  let latestCounter = 0;

  for (const [ip, data] of oplogData.entries()) {
    if (data.time > latestTime || (data.time === latestTime && data.counter > latestCounter)) {
      latestIP = ip;
      latestHostname = data.hostname;
      latestTime = data.time;
      latestCounter = data.counter;
    }
  }

  if (latestIP) {
    log(`Node with latest data: ${latestHostname} (${latestIP}) - timestamp: ${latestTime}.${latestCounter}`);
    return {
      ip: latestIP,
      hostname: latestHostname,
      time: latestTime,
      counter: latestCounter,
      isMe: latestIP === myIP
    };
  }

  return null;
}

// Step down and attempt to rejoin the cluster
async function stepDownAndRejoin(consensusPrimary) {
  log('SPLIT-BRAIN DETECTED: Attempting to step down and rejoin cluster');

  try {
    // Step down as PRIMARY
    log('Stepping down as PRIMARY...');
    const admin = mongoClient.db('admin');

    try {
      await admin.command({ replSetStepDown: 60 }); // Step down for 60 seconds
      log('Successfully stepped down as PRIMARY');
    } catch (stepDownError) {
      // If we're not primary, this will fail - that's okay
      log(`Step down result: ${stepDownError.message}`);
    }

    // Wait for cluster to stabilize
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Try to rejoin by forcing a resync with the majority's primary
    log(`Attempting to reconnect and sync with consensus PRIMARY: ${consensusPrimary}`);

    // Reconnect to MongoDB
    await mongoClient.close();
    await connectMongo();

    // Check if we successfully joined
    await new Promise(resolve => setTimeout(resolve, 3000));
    const status = await getReplicaSetStatus();

    if (!status.notInitialized && !status.needsAuth) {
      log('Successfully rejoined the cluster');
      return true;
    }

    log('Failed to rejoin cluster normally, initiating nuclear option...');
    return false;

  } catch (error) {
    log(`Error during step-down and rejoin: ${error.message}`);
    return false;
  }
}

// Nuclear option: Wipe data and force full resync
async function nuclearResync(peerIPs) {
  log('NUCLEAR OPTION: Considering data wipe and full resync');

  try {
    // SAFETY CHECK: Compare our oplog timestamp with peers
    // Only wipe if we're behind (old/stale data) or truly out of sync
    const latestDataNode = await findNodeWithLatestData(peerIPs);

    if (latestDataNode) {
      if (latestDataNode.isMe) {
        log('ABORT NUCLEAR RESYNC: This node has the LATEST data!');
        log('Peers should resync from us, not the other way around.');
        log('This is likely a split-brain where we were the active PRIMARY.');
        log('Waiting for peers to recognize our authority...');
        return;
      }

      log(`Confirmed: Node ${latestDataNode.hostname} has newer data than us`);
      log(`Their timestamp: ${latestDataNode.time}.${latestDataNode.counter}`);

      const myOplog = await getLatestOplogTimestamp();
      if (myOplog) {
        log(`Our timestamp: ${myOplog.time}.${myOplog.counter}`);
        const timeDiff = latestDataNode.time - myOplog.time;
        log(`We are ${timeDiff} seconds behind`);
      }
    }

    // Proceed with nuclear option
    log('Proceeding with nuclear resync: Wiping data and forcing full resync');

    // Close MongoDB connection
    if (mongoClient) {
      await mongoClient.close();
      mongoClient = null;
    }

    // Stop MongoDB process
    log('Stopping MongoDB process...');
    await execAsync('pkill -SIGTERM mongod');
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Wipe data directory (preserve logs)
    log('Wiping /data/db directory...');
    await execAsync('rm -rf /data/db/*');

    // Recreate necessary directories
    await execAsync('mkdir -p /data/db');

    log('Data wiped. Container will restart and resync from scratch.');
    log('Exiting to trigger container restart...');

    // Exit container - orchestrator will restart it
    process.exit(1);

  } catch (error) {
    log(`FATAL: Nuclear resync failed: ${error.message}`);
    log('Manual intervention required');
    throw error;
  }
}

// Reconcile replica set membership
async function reconcileReplicaSet(peerIPs) {
  // Update /etc/hosts with peer hostnames (needed for DNS resolution)
  await updateHostsFile(peerIPs);

  const isPrimaryNow = await isPrimary();

  if (!isPrimaryNow) {
    log('Not primary, skipping reconciliation');
    return;
  }

  // SPLIT-BRAIN DETECTION: Only PRIMARY nodes check peer consensus
  // This prevents split-brain scenarios where multiple nodes think they're primary
  const allIPs = await fetchAllIPs();
  const totalKnownNodes = allIPs.length;

  if (totalKnownNodes > 1) {
    const consensus = await checkPeerPrimaryConsensus(peerIPs);
    const { primaryVotes, reachablePeers, totalPeers } = consensus;

    // Calculate majority threshold (>50% of ALL known nodes)
    const majorityThreshold = Math.floor(totalKnownNodes / 2) + 1;

    log(`Consensus check: ${reachablePeers} reachable peers out of ${totalPeers} total (${totalKnownNodes} known nodes)`);

    // Check if majority of peers agree on a different PRIMARY
    let consensusPrimary = null;
    let consensusCount = 0;

    for (const [primary, count] of primaryVotes.entries()) {
      if (count >= majorityThreshold) {
        consensusPrimary = primary;
        consensusCount = count;
        break;
      }
    }

    if (consensusPrimary) {
      const myPrimaryHost = `${myHostname}:${MONGO_PORT}`;

      if (consensusPrimary !== myPrimaryHost) {
        log(`SPLIT-BRAIN DETECTED: ${consensusCount}/${totalKnownNodes} nodes think ${consensusPrimary} is PRIMARY, but I think I am (${myPrimaryHost})`);

        // Attempt to step down and rejoin
        const rejoinSuccess = await stepDownAndRejoin(consensusPrimary);

        if (!rejoinSuccess) {
          // Nuclear option: wipe data and full resync
          // Pass peerIPs so we can check who has the latest data
          await nuclearResync(peerIPs);
        }

        return; // Exit reconciliation after handling split-brain
      } else {
        log(`Consensus confirmed: Majority agrees I am PRIMARY`);
      }
    } else {
      log(`No majority consensus on PRIMARY (need ${majorityThreshold}/${totalKnownNodes} votes)`);
    }
  }

  // Try to get config, if auth fails, reconnect
  let config = await getReplicaSetConfig();

  if (!config) {
    // Might be an authentication issue after PRIMARY election
    // Try reconnecting with auth
    log('Failed to get replica set config, attempting to reconnect with authentication...');
    try {
      await mongoClient.close();
      await connectMongo();
      config = await getReplicaSetConfig();

      if (config) {
        log('Successfully reconnected and retrieved config');
      } else {
        log('Still cannot get config after reconnect, skipping reconciliation');
        return;
      }
    } catch (error) {
      log(`Error reconnecting: ${error.message}`);
      return;
    }
  }

  // Convert IPs to hostnames for comparison
  const currentMembers = config.members.map(m => m.host.split(':')[0]);
  const peerHostnames = peerIPs.map(ip => `mongo-${ip.replace(/\./g, '-')}.mongo-cluster`);
  const desiredMembers = [myHostname, ...peerHostnames];

  // Members to add
  const toAdd = desiredMembers.filter(hostname => !currentMembers.includes(hostname));

  // Members to remove (excluding self)
  const toRemove = currentMembers.filter(hostname =>
    hostname !== myHostname &&
    !desiredMembers.includes(hostname)
  );

  if (toAdd.length === 0 && toRemove.length === 0) {
    log('Replica set membership is in sync');
    return;
  }

  // Add new members
  for (const hostname of toAdd) {
    try {
      const maxId = Math.max(...config.members.map(m => m._id));
      config.members.push({ _id: maxId + 1, host: `${hostname}:${MONGO_PORT}` });
      log(`Adding member: ${hostname}:${MONGO_PORT}`);
    } catch (error) {
      log(`Error preparing to add ${hostname}: ${error.message}`);
    }
  }

  // Remove members
  for (const hostname of toRemove) {
    const index = config.members.findIndex(m => m.host.startsWith(hostname));
    if (index !== -1) {
      config.members.splice(index, 1);
      log(`Removing member: ${hostname}:${MONGO_PORT}`);
    }
  }

  // Note: Do NOT recalculate member IDs - MongoDB doesn't allow changing _id of existing members
  // Member IDs don't need to be sequential, they just need to be unique

  // Update configuration
  try {
    config.version++;
    const admin = mongoClient.db('admin');
    await admin.command({ replSetReconfig: config });
    log('Replica set reconfigured successfully');
  } catch (error) {
    log(`Error reconfiguring replica set: ${error.message}`);

    // Detect split-brain: Different replica set IDs
    if (error.message.includes('Our replica set ID did not match') ||
        error.message.includes('replSetId') && error.message.includes('requestTargetReplSetId')) {
      log('SPLIT-BRAIN DETECTED: Attempting to add member from different replica set');
      log('This indicates multiple independent replica sets were initialized');

      // Trigger nuclear resync to join the correct replica set
      await nuclearResync(peerIPs);
    }
  }
}

// Main reconciliation loop
async function reconciliationLoop() {
  while (true) {
    try {
      const peerIPs = await fetchPeerIPs();
      await reconcileReplicaSet(peerIPs);
    } catch (error) {
      log(`Reconciliation error: ${error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, RECONCILE_INTERVAL));
  }
}

// Get public IP by making external request
async function getPublicIP() {
  try {
    // Try ipify service
    const response = await fetch('https://api.ipify.org?format=json', { timeout: 5000 });
    const data = await response.json();
    if (data.ip) {
      log(`Detected public IP from ipify: ${data.ip}`);
      return data.ip;
    }
  } catch (error) {
    log(`Could not get public IP from ipify: ${error.message}`);
  }

  // Try ip-api.com as fallback
  try {
    const response = await fetch('http://ip-api.com/json/', { timeout: 5000 });
    const data = await response.json();
    if (data.query) {
      log(`Detected public IP from ip-api: ${data.query}`);
      return data.query;
    }
  } catch (error) {
    log(`Could not get public IP from ip-api: ${error.message}`);
  }

  return null;
}

// Bootstrap cluster
async function bootstrap() {
  log(`Starting cluster bootstrap (v${VERSION})`);

  // Get private IP
  const privateIP = await getLocalIP();
  log(`Private IP: ${privateIP}`);

  // Determine which IP to use for cluster operations
  // For local testing (FLUX_API_OVERRIDE set), use private IP
  // For production (Flux network), use public IP
  if (process.env.FLUX_API_OVERRIDE) {
    // Local testing mode - use private IP
    myIP = privateIP;
    log(`Local testing mode detected (FLUX_API_OVERRIDE set), using private IP: ${myIP}`);
  } else if (process.env.NODE_PUBLIC_IP) {
    // Manual override
    myIP = process.env.NODE_PUBLIC_IP;
    log(`Using NODE_PUBLIC_IP from environment: ${myIP}`);
  } else {
    // Production mode - detect public IP
    const publicIP = await getPublicIP();
    if (publicIP) {
      myIP = publicIP;
      log(`Using detected public IP: ${myIP}`);
    } else {
      // Fetch all IPs from Flux API
      const allIPs = await fetchAllIPs();
      if (allIPs.length === 0) {
        log('ERROR: Could not determine public IP and Flux API returned no nodes');
        process.exit(1);
      }

      if (allIPs.length === 1) {
        myIP = allIPs[0];
        log(`Single node deployment, using Flux API IP: ${myIP}`);
      } else {
        log('WARNING: Multiple nodes but cannot determine which public IP is ours');
        log('Please set NODE_PUBLIC_IP environment variable for proper operation');
        log(`Available IPs from Flux API: ${allIPs.join(', ')}`);
        // Use private IP as fallback - this will cause issues but at least shows the problem
        myIP = privateIP;
      }
    }
  }

  log(`Using IP for cluster operations: ${myIP}`);

  // In NAT environments, convert IP to hostname for replica set config
  // Format: mongo-{IP-with-dashes}.mongo-cluster (e.g., mongo-144-76-19-203.mongo-cluster)
  myHostname = `mongo-${myIP.replace(/\./g, '-')}.mongo-cluster`;
  log(`Using hostname for replica set: ${myHostname}`);

  // Update /etc/hosts with ALL peer hostnames BEFORE connecting
  // This is needed so nodes can discover existing replica sets
  const allIPs = await fetchAllIPs();
  const peerIPs = allIPs.filter(ip => ip !== myIP);
  if (peerIPs.length > 0) {
    await updateHostsFile(peerIPs);
  }

  // Add random startup delay (0-10 seconds) to prevent simultaneous initialization
  // This helps avoid race conditions when multiple nodes start at the same time
  if (peerIPs.length > 0) {
    const delay = Math.floor(Math.random() * 10000);
    log(`Adding startup jitter: ${delay}ms to prevent race conditions`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Connect to MongoDB
  const client = await connectMongo();
  if (!client) {
    log('ERROR: Could not connect to MongoDB');
    process.exit(1);
  }

  // Check if replica set is initialized
  const status = await getReplicaSetStatus();

  if (status.needsAuth) {
    // Replica set exists but we need authentication
    log('Replica set already initialized, reconnecting with authentication...');
    await mongoClient.close();
    await connectMongo();
  } else if (status.notInitialized) {
    log('Replica set not initialized');

    // Fetch peers and determine leader
    const peerIPs = await fetchPeerIPs();

    // SAFETY CHECK: Before initializing, check if any peer already has a replica set
    // This prevents a new node with lower IP from creating a conflicting replica set
    const peerHasReplicaSet = await checkPeersForReplicaSet(peerIPs);

    if (peerHasReplicaSet) {
      log('A peer node already has an initialized replica set, waiting to join...');
      // Wait for this node to be added to the replica set
      let initialized = false;
      for (let i = 0; i < 30; i++) { // Max 5 minutes
        await new Promise(resolve => setTimeout(resolve, 10000));
        const newStatus = await getReplicaSetStatus();
        if (!newStatus.notInitialized) {
          initialized = true;
          log('Successfully joined existing replica set');
          break;
        }
        log('Waiting to be added to existing replica set...');
      }

      if (!initialized) {
        log('WARNING: Not added to replica set after 5 minutes');
      }

      // Reconnect with authentication
      log('Reconnecting with authentication...');
      await mongoClient.close();
      await connectMongo();
    } else {
      // No peer has a replica set, proceed with leader election
      const leader = await isLeader(peerIPs);

      if (leader) {
        log('This node is the leader, initializing replica set');
        await initializeReplicaSet();
      } else {
        log('Not the leader, waiting for replica set to be initialized by leader');

        // Wait for leader to initialize (poll every 10 seconds)
        let initialized = false;
        for (let i = 0; i < 30; i++) { // Max 5 minutes
          await new Promise(resolve => setTimeout(resolve, 10000));
          const newStatus = await getReplicaSetStatus();
          if (!newStatus.notInitialized) {
            initialized = true;
            log('Replica set has been initialized by leader');
            break;
          }
          log('Still waiting for leader to initialize replica set...');
        }

        if (!initialized) {
          log('WARNING: Replica set not initialized after 5 minutes');
          log('Checking if leader is reachable or if we should take over...');

          // Check which peers are actually reachable
          const reachablePeers = await getReachablePeers(peerIPs);
          const reachableIPs = [myIP, ...reachablePeers].sort();

          log(`Reachable nodes: ${reachableIPs.join(', ')}`);

          // If we're the lowest reachable IP, become the leader
          if (reachableIPs[0] === myIP) {
            log('This node is the lowest reachable IP, taking over as leader');
            const canBeLeader = await canReachSelf();

            if (canBeLeader) {
              log('Self-reachability check passed, initializing replica set');
              await initializeReplicaSet();
              initialized = true;
            } else {
              log('ERROR: Cannot reach self, cannot become leader');
            }
          } else {
            log(`Lowest reachable IP is ${reachableIPs[0]}, continuing to wait...`);
          }
        }

        if (initialized) {
          // Reconnect with authentication now that replica set is initialized
          log('Reconnecting with authentication...');
          await mongoClient.close();
          await connectMongo();
        }
      }
    }
  } else {
    log('Replica set already initialized');

    // Ensure we're connected with authentication
    // If we connected without auth (localhost exception), reconnect with auth
    try {
      const admin = mongoClient.db('admin');
      await admin.command({ ping: 1 });
      log('Already authenticated to MongoDB');
    } catch (error) {
      log('Not authenticated, reconnecting with credentials...');
      mongoClient.close();
      await connectMongo();
    }

    // SELF-HEALING: Check if we're in a split-brain situation
    // If majority of replica set is unreachable and we're not primary, force reconfig
    try {
      const admin = mongoClient.db('admin');
      const rsStatus = await admin.command({ replSetGetStatus: 1 });
      const members = rsStatus.members || [];
      const totalMembers = members.length;
      const reachableMembers = members.filter(m => m.health === 1).length;
      const hasNoPrimary = !members.some(m => m.state === 1);
      const iAmPrimary = members.some(m => m.self && m.state === 1);

      if (totalMembers > 1 && reachableMembers === 1 && hasNoPrimary) {
        log(`WARNING: Split-brain detected! ${reachableMembers}/${totalMembers} members reachable, no PRIMARY`);

        // SAFETY CHECK: Before force-reconfiguring, check if peers have newer data
        // If they do, we should NOT become PRIMARY - we should resync from them
        const peerIPs = await fetchPeerIPs();
        const latestDataNode = await findNodeWithLatestData(peerIPs);

        if (latestDataNode && !latestDataNode.isMe) {
          log(`ABORT force-reconfig: Peer ${latestDataNode.hostname} has newer data`);
          log(`Peer timestamp: ${latestDataNode.time}.${latestDataNode.counter}`);
          const myOplog = await getLatestOplogTimestamp();
          if (myOplog) {
            log(`Our timestamp: ${myOplog.time}.${myOplog.counter}`);
            const timeDiff = latestDataNode.time - myOplog.time;
            log(`We are ${timeDiff} seconds behind - waiting to resync from peers`);
          }
          log('Will wait for peers to add us back to the replica set');
        } else {
          log('Self-healing: Force-reconfiguring to single-node replica set');

          const config = await admin.command({ replSetGetConfig: 1 });
          const selfMember = members.find(m => m.self);

          if (selfMember) {
            const newConfig = {
              ...config.config,
              version: config.config.version + 1,
              members: [config.config.members.find(m => m._id === selfMember._id)]
            };

            await admin.command({ replSetReconfig: newConfig, force: true });
            log('Self-healing: Successfully reconfigured as single-node replica set');
            log('Waiting for PRIMARY election...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      } else if (iAmPrimary) {
        // I'm PRIMARY - check if peers have newer data than me
        // This handles the case where old PRIMARY comes back after new PRIMARY was elected
        const peerIPs = await fetchPeerIPs();
        if (peerIPs.length > 0) {
          const latestDataNode = await findNodeWithLatestData(peerIPs);

          if (latestDataNode && !latestDataNode.isMe) {
            log(`WARNING: I am PRIMARY but peer ${latestDataNode.hostname} has newer data!`);
            log(`Peer timestamp: ${latestDataNode.time}.${latestDataNode.counter}`);
            const myOplog = await getLatestOplogTimestamp();
            if (myOplog) {
              log(`Our timestamp: ${myOplog.time}.${myOplog.counter}`);
              const timeDiff = latestDataNode.time - myOplog.time;
              log(`We are ${timeDiff} seconds behind`);

              if (timeDiff > 0) {
                log('Old PRIMARY detected: Stepping down to allow newer PRIMARY to take over');
                try {
                  await admin.command({ replSetStepDown: 300 }); // Step down for 5 minutes
                  log('Successfully stepped down as PRIMARY');
                } catch (stepDownError) {
                  log(`Step down error: ${stepDownError.message}`);
                }
              }
            }
          }
        }
      }
    } catch (error) {
      log(`Error during split-brain check: ${error.message}`);
    }
  }

  // Start reconciliation loop
  log('Starting reconciliation loop');
  reconciliationLoop();
}

// REST API
const app = express();

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', async (req, res) => {
  try {
    const status = await getReplicaSetStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/members', async (req, res) => {
  try {
    const config = await getReplicaSetConfig();
    const members = config ? config.members.map(m => ({
      id: m._id,
      host: m.host,
      priority: m.priority || 1
    })) : [];
    res.json({ members });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/primary', async (req, res) => {
  try {
    const status = await getReplicaSetStatus();
    const primary = status.members?.find(m => m.state === 1);
    res.json({
      primary: primary ? primary.name : null,
      isPrimary: await isPrimary()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/info', (req, res) => {
  res.json({
    myIP,
    myHostname,
    replicaSet: REPLICA_SET_NAME,
    appName: APP_NAME,
    reconcileInterval: RECONCILE_INTERVAL
  });
});

app.get('/oplog', async (req, res) => {
  try {
    const oplog = await getLatestOplogTimestamp();
    if (oplog) {
      res.json({
        hostname: myHostname,
        ip: myIP,
        timestamp: {
          time: oplog.time,
          counter: oplog.counter
        }
      });
    } else {
      res.json({
        hostname: myHostname,
        ip: myIP,
        timestamp: null
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(API_PORT, () => {
  log(`API server listening on port ${API_PORT}`);
  bootstrap().catch(error => {
    log(`FATAL: Bootstrap failed: ${error.message}`);
    log(`Stack trace: ${error.stack}`);
    log('Container will stay running for debugging. Check logs above for details.');
    // Keep the API server running so we can inspect the state
  });
});

// Global error handlers
process.on('uncaughtException', (error) => {
  log(`UNCAUGHT EXCEPTION: ${error.message}`);
  log(`Stack trace: ${error.stack}`);
  log('Container will stay running for debugging. Check logs above for details.');
});

process.on('unhandledRejection', (reason, promise) => {
  log(`UNHANDLED REJECTION at: ${promise}`);
  log(`Reason: ${reason}`);
  log('Container will stay running for debugging. Check logs above for details.');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  log('Received SIGTERM, shutting down gracefully');
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});
