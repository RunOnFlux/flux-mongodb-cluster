# Flux MongoDB Cluster

A self-configuring and self-healing MongoDB replica set designed for deployment on Flux infrastructure. This solution provides a single Docker image that automatically discovers peer nodes via the Flux API and manages replica set membership dynamically.

## Features

- **Zero-Touch Deployment**: Automatically forms MongoDB replica sets using environment variables
- **Dynamic Discovery**: Discovers peer nodes via Flux API endpoint
- **Self-Healing**: Automatically adds new nodes and removes failed nodes
- **Deterministic Leader Election**: Uses lowest IP address for consistent cluster initialization
- **Smart Primary Detection**: Fast primary election detection with progressive backoff
- **Primary Failover Handling**: Automatically detects primary changes and reassigns responsibilities
- **Split-Brain Prevention**: Only PRIMARY nodes perform cluster management operations
- **Secure Communication**: Implements keyfile authentication for replica set members
- **Production Ready**: Built on MongoDB 7.0 with proper authentication and security
- **Automatic Restart**: Containers restart on failure with configurable backoff
- **Failure Recovery**: Handles API failures, MongoDB crashes, and network partitions
- **Retry Logic**: Multiple retry attempts for critical operations with exponential backoff

## Architecture

The system consists of three main components:

1. **Docker Image**: Based on MongoDB 7.0 with curl and jq for API interactions
2. **Entrypoint Controller**: Manages initialization, leader election, and reconciliation
3. **Reconciliation Loop**: Continuously syncs replica set membership with Flux API state

## Quick Start

### Building the Image

```bash
docker build -t flux-mongodb:latest .
```

### Running on Flux

Deploy the same image on multiple Flux nodes with these environment variables:

```bash
docker run -d \
  -e APP_NAME="my-mongo-cluster" \
  -e MONGO_REPLICA_SET_NAME="rs0" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="your-secure-password" \
  -v /data/mongo:/data/db \
  --name mongo-node \
  flux-mongodb:latest
```

### Local Testing with Docker Compose

For local testing, use the provided docker-compose configuration:

```bash
# Build and start the cluster
docker-compose up --build

# Connect to the cluster
mongosh "mongodb://admin:secretpassword@localhost:27017/?replicaSet=rs0"

# Check replica set status
docker exec mongo-node1 mongosh --eval "rs.status()"

# Stop the cluster
docker-compose down

# Clean up volumes
docker-compose down -v
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `APP_NAME` | Flux application name for API queries | `mongo-cluster` |
| `MONGO_REPLICA_SET_NAME` | Name of the MongoDB replica set | `rs0` |
| `MONGO_PORT` | MongoDB port | `27017` |
| `MONGO_INITDB_ROOT_USERNAME` | Admin username (optional) | - |
| `MONGO_INITDB_ROOT_PASSWORD` | Admin password (optional) | - |
| `MONGO_KEYFILE_PASSPHRASE` | Passphrase for deterministic keyfile generation | - |
| `MONGO_KEYFILE_SALT` | Salt for keyfile generation | `mongodb-flux-cluster-salt` |
| `MONGO_KEYFILE_CONTENT` | Direct keyfile content (overrides passphrase) | - |
| `RECONCILE_INTERVAL` | Seconds between reconciliation checks | `60` |

## Production Deployment

For real-world deployments where nodes are on different servers, you need to share the MongoDB keyfile. See [PRODUCTION.md](PRODUCTION.md) for detailed instructions on:
- Keyfile distribution strategies
- Secret management integration
- Security best practices
- Flux-specific deployment

**Quick Start for Production:**
```bash
# Method 1: Using a passphrase (RECOMMENDED)
# All nodes generate the same keyfile from the same passphrase
docker run -d \
  -e APP_NAME="production-mongo" \
  -e MONGO_KEYFILE_PASSPHRASE="your-secret-passphrase-here" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="secure-password" \
  -v /data/mongo:/data/db \
  flux-mongodb:latest

# Method 2: Using pre-generated keyfile
KEYFILE=$(openssl rand -base64 756)
docker run -d \
  -e APP_NAME="production-mongo" \
  -e MONGO_KEYFILE_CONTENT="$KEYFILE" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="secure-password" \
  -v /data/mongo:/data/db \
  flux-mongodb:latest
```

## How It Works

### 1. Initialization Phase
- Each container generates or uses an existing keyfile for secure replica set communication
- MongoDB daemon starts with replica set configuration
- Container discovers its own IP address

### 2. Discovery & Bootstrap Phase
- Container queries Flux API: `https://api.runonflux.io/apps/location/{APP_NAME}`
- Parses response to get list of all peer IPs
- Determines leader using lowest IP address
- Leader initializes replica set with all discovered peers
- **Fast Primary Election**: System uses progressive backoff to quickly detect primary
- **Smart User Creation**: Only PRIMARY nodes create admin users, preventing authentication conflicts
- Non-leaders wait for initialization

### 3. Reconciliation Loop
- **Primary-Only Operations**: Only the current PRIMARY node performs reconciliation
- **Primary Change Detection**: Continuously monitors for primary status changes and reassigns responsibilities
- Primary node periodically queries Flux API for current node list
- Compares desired state (API) with current state (replica set)
- Adds new members that appear in API
- Removes members that disappear from API
- **Mid-Operation Safety**: Verifies PRIMARY status before each cluster modification
- Includes safety checks to prevent removing majority
- **Automatic Restart**: On failures, containers restart automatically instead of exiting

## API Integration

The controller queries the Flux API endpoint to discover peers:

```
GET https://api.runonflux.io/apps/location/{APP_NAME}
```

Expected response format:
```json
{
  "data": [
    {"ip": "192.168.1.10:31000"},
    {"ip": "192.168.1.11:31000"},
    {"ip": "192.168.1.12:31000"}
  ]
}
```

## Security Considerations

- **Internal Authentication**: Replica set members authenticate using a shared keyfile
- **Client Authentication**: Optional username/password authentication for clients
- **Network Security**: Bind to all interfaces (`--bind_ip_all`) - ensure proper firewall rules
- **Data Persistence**: Always mount volumes for `/data/db` to preserve data

## Monitoring & Troubleshooting

### View Logs
```bash
# Container logs (controller output)
docker logs mongo-node

# MongoDB logs
docker exec mongo-node cat /data/db/mongod.log
```

### Check Replica Set Status
```bash
# Connect with authentication
mongosh "mongodb://admin:password@localhost:27017/?replicaSet=rs0"

# Check status
rs.status()

# View configuration
rs.config()

# Check if primary
db.hello()
```

### Common Issues

1. **Nodes not joining cluster**: Check network connectivity and Flux API response
2. **Authentication failures**: Ensure all nodes have same keyfile
3. **Primary election issues**: Verify at least one node can reach majority
4. **API failures**: Controller preserves last-known configuration during API outages

## Production Deployment

### Prerequisites
- Docker installed on all Flux nodes
- Network connectivity between nodes on port 27017
- Persistent storage for MongoDB data

### Recommended Settings
```bash
docker run -d \
  --restart=unless-stopped \
  --memory="2g" \
  --cpus="2" \
  -e APP_NAME="production-mongo" \
  -e MONGO_REPLICA_SET_NAME="rs0" \
  -e MONGO_INITDB_ROOT_USERNAME="admin" \
  -e MONGO_INITDB_ROOT_PASSWORD="$(openssl rand -base64 32)" \
  -e RECONCILE_INTERVAL="30" \
  -v /data/mongo:/data/db:rw \
  -v /data/mongo-config:/data/configdb:rw \
  --name mongo-node \
  flux-mongodb:latest
```

### Backup Strategy
- Use `mongodump` for logical backups
- Snapshot volumes for filesystem-level backups
- Consider MongoDB Atlas or similar for managed backups

## Development

### Project Structure
```
.
├── Dockerfile           # Docker image definition
├── entrypoint.sh       # Controller script
├── docker-compose.yml  # Local testing setup
├── nginx.conf         # Mock API server configuration
├── mock-api/          # Mock Flux API responses
└── README.md          # This file
```

### Testing Locally

To test the reconciliation logic locally:

1. Start the cluster: `docker-compose up`
2. Simulate node failure: `docker stop mongo-node2`
3. Watch logs: `docker logs -f mongo-node1`
4. Bring node back: `docker start mongo-node2`

## Contributing

Contributions are welcome! Please consider:

- Adding tests for the controller logic
- Implementing additional safety checks
- Adding metrics/monitoring endpoints
- Improving error handling and logging

## License

This project is provided as-is for use with Flux infrastructure.

## Support

For issues related to:
- MongoDB: Consult [MongoDB documentation](https://docs.mongodb.com/)
- Flux API: Visit [Flux documentation](https://docs.runonflux.io/)
- This project: Open an issue in the repository