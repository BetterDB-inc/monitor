#!/bin/bash

# Demo Slot Migration Script
# This script migrates slots between cluster nodes to demonstrate the migration visualization

set -e

echo " Valkey Cluster Slot Migration Demo"
echo ""
echo "This will migrate slots 100-110 from node-1 to node-2"
echo "You'll be able to see the migration progress in the BetterDB Monitor."
echo ""

# Get node IDs
NODE1_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "myself,master" | awk '{print $1}')
NODE2_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "valkey-node-2.*master" | awk '{print $1}')

echo " Current state:"
echo "  Node 1 ID: ${NODE1_ID:0:12}... (slots 0-5460)"
echo "  Node 2 ID: ${NODE2_ID:0:12}... (slots 5461-10922)"
echo ""

read -p "Start migration? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted"
    exit 0
fi

echo ""
echo "Starting slot migration..."
echo ""

# Migrate slots 100-110 (11 slots total)
for slot in {100..110}; do
    echo "  Migrating slot $slot..."

    # Mark slot as migrating on source (node-1)
    docker exec valkey-node-1 valkey-cli cluster setslot $slot migrating $NODE2_ID

    # Mark slot as importing on target (node-2)
    docker exec valkey-node-2 valkey-cli cluster setslot $slot importing $NODE1_ID

    # Get keys in this slot
    keys=$(docker exec valkey-node-1 valkey-cli cluster getkeysinslot $slot 1000)

    if [ ! -z "$keys" ]; then
        # Migrate each key
        for key in $keys; do
            docker exec valkey-node-1 valkey-cli migrate valkey-node-2 6379 "$key" 0 5000 || true
        done
    fi

    # Complete the migration on both nodes
    docker exec valkey-node-1 valkey-cli cluster setslot $slot node $NODE2_ID
    docker exec valkey-node-2 valkey-cli cluster setslot $slot node $NODE2_ID

    echo "    Slot $slot migrated"
done

echo ""
echo "Migration complete!"
echo ""
echo " Check the BetterDB Monitor:"
echo "  1. Go to Cluster Overview tab"
echo "  2. Look at the 'Slot Migrations' card"
echo "  3. Refresh the page to see updated slot distribution"
echo ""
echo "Current slot distribution:"
docker exec valkey-node-1 valkey-cli cluster nodes | grep master | while read line; do
    node=$(echo "$line" | awk '{print $2}' | cut -d: -f1)
    slots=$(echo "$line" | grep -o '[0-9]*-[0-9]*' | head -1)
    echo "  $node: $slots"
done
