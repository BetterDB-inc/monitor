# Valkey Cluster Setup Guide

This guide explains how to set up a Valkey cluster with replication for development and testing.

## Quick Start

### Option 1: Automated Setup (Recommended)

Run the setup script to create a 6-node cluster (3 masters + 3 replicas):

```bash
./cluster-setup.sh
```

This will:
- Start 6 Valkey nodes
- Create a cluster with 3 masters and 3 replicas
- Display connection information

### Option 2: Manual Setup

```bash
# Start the cluster
docker compose -f docker-compose.cluster.yml up -d

# The cluster will be automatically initialized
```

## Cluster Configuration

The cluster consists of:
- **3 Master Nodes**: Handle read/write operations, each managing ~5,461 slots
- **3 Replica Nodes**: Provide redundancy and read scaling, one replica per master

### Port Mapping

| Node | Type | Container Port | Host Port | Cluster Bus Port |
|------|------|---------------|-----------|------------------|
| valkey-node-1 | Master | 6379 | 7001 | 17001 |
| valkey-node-2 | Master | 6379 | 7002 | 17002 |
| valkey-node-3 | Master | 6379 | 7003 | 17003 |
| valkey-node-4 | Replica | 6379 | 7004 | 17004 |
| valkey-node-5 | Replica | 6379 | 7005 | 17005 |
| valkey-node-6 | Replica | 6379 | 7006 | 17006 |

## Connecting Your Application

### Update Environment Variables

Connect your BetterDB Monitor to the cluster:

```bash
# In apps/api/.env
DB_HOST=localhost
DB_PORT=7001
DB_USERNAME=
DB_PASSWORD=
```

The monitor will automatically detect cluster mode and connect to all nodes.

### Connection from Docker Containers

If your application runs in Docker, use the internal network:

```bash
DB_HOST=valkey-node-1
DB_PORT=6379
```

Add your application to the cluster network:

```yaml
networks:
  - valkey-cluster

networks:
  valkey-cluster:
    external: true
```

## Cluster Management

### Check Cluster Status

```bash
# Cluster info
docker exec valkey-node-1 valkey-cli cluster info

# List all nodes
docker exec valkey-node-1 valkey-cli cluster nodes

# Check replication status
docker exec valkey-node-4 valkey-cli info replication
```

### Test Replication

```bash
# Write to master
docker exec valkey-node-1 valkey-cli set mykey "hello"

# Read from replica
docker exec valkey-node-4 valkey-cli get mykey
```

### Failover Testing

```bash
# Trigger manual failover on a replica
docker exec valkey-node-4 valkey-cli cluster failover

# Check cluster status after failover
docker exec valkey-node-1 valkey-cli cluster nodes
```

### Add Data for Testing

```bash
# Add sample data to test slot distribution
for i in {1..1000}; do
  docker exec valkey-node-1 valkey-cli set "key$i" "value$i"
done

# Check key distribution across slots
docker exec valkey-node-1 valkey-cli cluster countkeysinslot 0 1000
```

## Cluster Operations

### Stop the Cluster

```bash
# Stop all nodes
docker compose -f docker-compose.cluster.yml down

# Stop and remove all data
docker compose -f docker-compose.cluster.yml down -v
```

### View Logs

```bash
# All nodes
docker compose -f docker-compose.cluster.yml logs -f

# Specific node
docker compose -f docker-compose.cluster.yml logs -f valkey-node-1
```

### Restart a Node

```bash
# Restart specific node
docker compose -f docker-compose.cluster.yml restart valkey-node-1

# The cluster will automatically reconnect
```

## Monitoring with BetterDB Monitor

Once connected, the monitor will show:

1. **Cluster Overview Tab**:
   - Cluster health status
   - Master/replica topology graph
   - Slot distribution heatmap
   - Replication lag metrics

2. **Nodes Tab**:
   - Individual node statistics
   - Memory usage comparison
   - Operations per second
   - Client connections

3. **Replication Tab**:
   - Replication lag for each replica
   - Master link status
   - Replication offset tracking

## Troubleshooting

### Cluster Creation Failed

If cluster initialization fails:

```bash
# Clean up and retry
docker compose -f docker-compose.cluster.yml down -v
./cluster-setup.sh
```

### Connection Errors from Monitor

If you see "ENOTFOUND valkey-node-X" errors:

1. **Running monitor outside Docker**: Use host ports (7001-7006)
   ```bash
   DB_HOST=localhost
   DB_PORT=7001
   ```

2. **Running monitor inside Docker**: Use internal network and container names
   ```bash
   DB_HOST=valkey-node-1
   DB_PORT=6379
   ```

### Node Won't Join Cluster

```bash
# Check node status
docker exec valkey-node-1 valkey-cli cluster info

# Reset node and recreate cluster
docker compose -f docker-compose.cluster.yml down -v
docker compose -f docker-compose.cluster.yml up -d
```

### Replication Not Working

```bash
# Check replica status
docker exec valkey-node-4 valkey-cli info replication

# Check master link
docker exec valkey-node-4 valkey-cli cluster nodes | grep myself

# Manual replication (if needed)
docker exec valkey-node-4 valkey-cli cluster replicate <master-node-id>
```

## Advanced Configuration

### Change Replication Factor

To create a cluster with 2 replicas per master (9 nodes total):

```bash
# Modify docker-compose.cluster.yml to add valkey-node-7, 8, 9
# Then update the cluster create command:
valkey-cli --cluster create \
  node1:6379 node2:6379 node3:6379 \
  node4:6379 node5:6379 node6:6379 \
  node7:6379 node8:6379 node9:6379 \
  --cluster-replicas 2
```

### Enable Authentication

Add to each node's command in docker-compose.cluster.yml:

```yaml
command: >
  valkey-server
  --requirepass yourpassword
  --cluster-enabled yes
  ...
```

Then update cluster creation:

```bash
valkey-cli -a yourpassword --cluster create ...
```

## Resources

- [Valkey Cluster Documentation](https://valkey.io/topics/cluster-tutorial/)
- [Redis Cluster Specification](https://redis.io/docs/reference/cluster-spec/)
- [BetterDB Monitor Documentation](./README.md)
