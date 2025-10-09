# Flux MongoDB Cluster
![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)
![MongoDB](https://img.shields.io/badge/MongoDB-7.0-green.svg)
![Docker](https://img.shields.io/badge/Docker-required-blue.svg)

This project creates a self-configuring, highly-available MongoDB replica set that dynamically discovers its members through the Flux API. The cluster automatically adapts to nodes being added or removed from the environment.

## Architecture

- **Single Docker Image**: Contains MongoDB 7.0, Node.js, and automation controller
- **Geographic Distribution**: Each instance runs on a different physical Flux node (potentially worldwide)
- **Public Internet Replication**: MongoDB nodes communicate over the public internet using their public IPs
- **Auto IP Detection**: Automatically detects public IP for proper cluster formation
- **Dynamic Discovery**: Calls Flux API to discover cluster members' public IP addresses
- **Auto-Configuration**: Generates replica set configuration based on live API data
- **Self-Healing**: Periodically updates cluster membership to match API state
- **Leader Election**: Deterministic primary selection using lowest IP address
- **REST API**: Built-in HTTP API for cluster status and monitoring

## Prerequisites

- Docker
- Docker Compose
- Access to Flux network for API calls

## Quick Start

### Production Deployment on Flux Network

#### Architecture Overview

```
   ┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
   │      Node 1      │       │      Node 2      │       │       Node 3     │
   │  ┌────────────┐  │       │  ┌────────────┐  │       │  ┌────────────┐  │
   │  │  Your App  │  │       │  │  Your App  │  │       │  │  Your App  │  │
   │  │ (Component)│  │       │  │ (Component)│  │       │  │ (Component)│  │
   │  └─────┬──────┘  │       │  └─────┬──────┘  │       │  └─────┬──────┘  │
   │  ┌─────▼──────┐  │       │  ┌─────▼──────┐  │       │  ┌─────▼──────┐  │
   │  │  MongoDB   │  │       │  │  MongoDB   │  │       │  │  MongoDB   │  │
   │  │  PRIMARY   │◄─┼───────┼─►│ SECONDARY  │◄─┼───────┼─►│ SECONDARY  │  │
   │  │(Read+Write)│  │       │  │ (Read-Only)│  │       │  │ (Read-Only)│  │
   │  └────────────┘  │       │  └────────────┘  │       │  └────────────┘  │
   └──────────────────┘       └──────────────────┘       └──────────────────┘
            │                          │                          │ 
            └──────────────────────────┼──────────────────────────┘
                                       │ 
                            Replication via Public Internet


Key Points:
• Each application instance connects ONLY to its local MongoDB instance directly (not to Replica Set)
• MongoDB instances replicate data across nodes via public internet
• Only PRIMARY accepts writes; SECONDARY nodes are read-only
• Applications must use proper connection strings for automatic failover
```

#### Important: Read/Write Behavior

**⚠️ MongoDB Replica Set Behavior:**
- **PRIMARY node**: Accepts both READ and WRITE operations
- **SECONDARY nodes**: Accept READ operations only (writes are rejected)
- **Automatic Failover**: If PRIMARY fails, a SECONDARY is automatically elected as new PRIMARY

**Application Implementation Requirements:**
1. **Use replica set connection string** (not direct connection):
   ```
   mongodb://admin:password@fluxMONGO_APPNAME:27017/?replicaSet=rs0
   ```
   This allows automatic failover when PRIMARY changes.

2. **Handle write failures gracefully**:
   - If your app connects to a SECONDARY and tries to write, it will receive a `NotWritablePrimary` error
   - Use replica set aware drivers that automatically route writes to PRIMARY

3. **Read preference options**:
   - `primary` (default): All reads go to PRIMARY
   - `primaryPreferred`: Read from PRIMARY, fallback to SECONDARY if unavailable
   - `secondary`: Read from SECONDARY only
   - `secondaryPreferred`: Read from SECONDARY, fallback to PRIMARY if no SECONDARY available

#### Deployment Steps

1. **Deploy MongoDB Cluster on Flux**:
   - Add a component for MongoDB
   - Use the official Docker image: `runonflux/flux-mongodb-cluster:latest`
   - Set environment variables for the MongoDB:
     ```
     APP_NAME=your-app-name
     MONGO_REPLICA_SET_NAME=rs0
     MONGO_INITDB_ROOT_USERNAME=admin
     MONGO_INITDB_ROOT_PASSWORD=your-super-secret-password
     MONGO_KEYFILE_PASSPHRASE=your-keyfile-passphrase
     ```
   - Set Container Data for the component to `/data/db`
   - Deploy 3 or more instances for high availability

2. **Deploy Your Application on Flux**:
   - Add a component for your application
   - Use your application's Docker image
   - Set MongoDB connection string to point to local MongoDB instance:
     ```
     MONGODB_URI=mongodb://admin:password@fluxMONGO_APPNAME:27017/?replicaSet=rs0
     ```
   - Deploy the same number of instances as MongoDB (1:1 ratio)

3. **Connection String Format**:
   ```bash
   # Basic connection (automatic failover enabled)
   mongodb://admin:[PASSWORD]@flux{MONGO_COMPONENT_NAME}_{APPNAME}:27017/?replicaSet=rs0

   # With read preference (recommended for read-heavy workloads)
   mongodb://admin:[PASSWORD]@flux{MONGO_COMPONENT_NAME}_{APPNAME}:27017/?replicaSet=rs0&readPreference=primaryPreferred
   ```

   **Important**: Always include `?replicaSet=rs0` in the connection string. This enables:
   - Automatic PRIMARY discovery
   - Automatic failover when PRIMARY changes
   - Proper routing of read/write operations

4. **Monitor your cluster**:
   - Connect to any node with mongosh
   - Check cluster status with `rs.status()`
   - View replica set configuration with `rs.config()`
   - Use REST API endpoints (see API Endpoints section below)

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_NAME` | Flux application name for API discovery | `mongo-cluster` |
| `MONGO_REPLICA_SET_NAME` | Name of the MongoDB replica set | `rs0` |
| `MONGO_PORT` | MongoDB port | `27017` |
| `MONGO_INITDB_ROOT_USERNAME` | Admin username | Required |
| `MONGO_INITDB_ROOT_PASSWORD` | Admin password | Required |
| `MONGO_KEYFILE_PASSPHRASE` | Passphrase for deterministic keyfile generation | Required |
| `MONGO_KEYFILE_SALT` | Salt for keyfile generation | `mongodb-flux-cluster-salt` |
| `MONGO_KEYFILE_CONTENT` | Direct keyfile content (overrides passphrase) | - |
| `NODE_PUBLIC_IP` | Override auto-detected public IP (optional) | Auto-detected |
| `MONGO_OPLOG_SIZE` | Oplog size in MB (larger = better rollback protection) | `2048` |
| `MONGO_WRITE_CONCERN_MAJORITY` | Enable write concern majority (set to `true`) | Disabled |
| `RECONCILE_INTERVAL` | Milliseconds between reconciliation checks | `30000` |
| `API_PORT` | REST API port | `3000` |
| `FLUX_API_OVERRIDE` | Override Flux API URL (for testing) | Production API |

## How It Works

### Startup Process

1. **IP Detection**: Automatically detects public IP using ipify.org or ip-api.com (can be overridden with `NODE_PUBLIC_IP` env var)
2. **MongoDB Startup**: Generates keyfile and starts MongoDB with replica set configuration
3. **Discovery Phase**: Calls `https://api.runonflux.io/apps/location/{APP_NAME}` to get all cluster member IPs
4. **Leader Election**: Determines leader using lowest IP address for consistent initialization
5. **Replica Set Init**: Leader node initializes replica set and creates admin user
6. **REST API**: Starts HTTP API on port 3000 for monitoring

### Dynamic Membership

- **Background Process**: Continuously monitors Flux API (every 30 seconds by default)
- **Automatic Removal**: Removes nodes from replica set when they're no longer in the API response
- **Self-Registration**: New nodes automatically join the cluster when they start up
- **Primary-Only Operations**: Only PRIMARY nodes perform cluster management operations

### REST API Endpoints

The built-in REST API provides cluster monitoring:

- `GET /health` - Health check endpoint
- `GET /status` - Full replica set status (equivalent to `rs.status()`)
- `GET /members` - List of replica set members
- `GET /primary` - Current primary node information
- `GET /info` - Node information (IP, replica set name, etc.)

Access the API at `http://[node-ip]:3000` (or the port specified in `API_PORT`)

### Cluster Management

The Node.js controller manages three main phases:

- **Initialization**: Keyfile generation and MongoDB startup (handled by entrypoint.sh)
- **Bootstrap**: IP detection, API discovery, leader election, and replica set initialization
- **Reconciliation**: Background loop that maintains cluster membership

### Access MongoDB

#### Connection Strings

**For connections from within Docker containers (inside the cluster network):**
```
Host: flux{COMPONENT_NAME}_{APPNAME}
Port: 27017
Database: admin
Username: admin
Password: [MONGO_INITDB_ROOT_PASSWORD]

Example connection string:
mongodb://admin:[PASSWORD]@flux{MONGO_COMPONENT_NAME}_{APPNAME}:27017/?replicaSet=rs0

# For read preference:
mongodb://admin:[PASSWORD]@flux{MONGO_COMPONENT_NAME}_{APPNAME}:27017/?replicaSet=rs0&readPreference=secondaryPreferred
```

**For external connections (from host machine or remote clients):**
```
Host: localhost (or server IP)
Port: 27017
Database: admin
Username: admin
Password: [MONGO_INITDB_ROOT_PASSWORD]

Example connection string:
mongodb://admin:[PASSWORD]@localhost:27017/?replicaSet=rs0
```

**For local testing with multiple nodes:**
- Node 1: `mongodb://admin:[PASSWORD]@localhost:27017/?replicaSet=rs0`
- Node 2: `mongodb://admin:[PASSWORD]@localhost:27018/?replicaSet=rs0`
- Node 3: `mongodb://admin:[PASSWORD]@localhost:27019/?replicaSet=rs0`

## Files Overview

- **Dockerfile**: Docker image definition
- **entrypoint.sh**: Controller script for cluster management
- **docker-compose.yml**: Local testing setup
- **nginx.conf**: Mock API server configuration
- **mock-api/**: Mock Flux API responses

### Local Testing

For local development and testing, this repository includes a complete mock environment:

1. **Start local test cluster**:
   ```bash
   docker-compose up -d --build
   ```

2. **Access local services**:
   - **Mock Flux API**: http://localhost:8080
   - **MongoDB nodes**:
     - Node 1: `localhost:27017`
     - Node 2: `localhost:27018`
     - Node 3: `localhost:27019`

3. **Connect to MongoDB**:
   ```bash
   # Default credentials from .env
   mongosh "mongodb://admin:secretpassword@localhost:27017/?replicaSet=rs0"
   ```

The local setup includes:
- **3-node MongoDB replica set** with automatic failover
- **Mock Flux API server** (nginx serving JSON files)
- **Isolated Docker network** simulating real deployment
- **All services** running on separate ports for testing


### Logs

Check logs for cluster operations:
```bash
# View container logs
docker logs mongo-node1

# View MongoDB logs
docker exec mongo-node1 cat /data/db/mongod.log
```

## Support

For issues related to:
- MongoDB: Consult [MongoDB documentation](https://docs.mongodb.com/)
- Flux API: Visit [Flux documentation](https://docs.runonflux.io/)
- This project: Open an issue in the repository