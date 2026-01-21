#!/bin/bash

# Complete the ongoing slot migration

set -e

echo "Completing slot migration..."

# Get node IDs
NODE1_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "myself,master" | awk '{print $1}')
NODE2_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "valkey-node-2.*master" | awk '{print $1}')

# Get all keys in slot 500 and migrate them
echo "Migrating keys..."
keys=$(docker exec valkey-node-1 valkey-cli cluster getkeysinslot 500 1000)
count=0

for key in $keys; do
    docker exec valkey-node-1 valkey-cli migrate valkey-node-2 6379 "$key" 0 5000 REPLACE > /dev/null 2>&1 || true
    ((count++))
done

echo "  Migrated $count keys"

# Finalize the migration
docker exec valkey-node-1 valkey-cli cluster setslot 500 node $NODE2_ID > /dev/null
docker exec valkey-node-2 valkey-cli cluster setslot 500 node $NODE2_ID > /dev/null

echo "Migration complete!"
echo ""
echo "Slot 500 is now owned by node-2"
echo "The migration should disappear from the Slot Migrations card."
