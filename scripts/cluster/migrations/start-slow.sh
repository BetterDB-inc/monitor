#!/bin/bash

# Slow Slot Migration for Demo
# This script starts a slot migration but pauses so you can see it in the monitor

set -e

echo " Starting Slow Slot Migration (Demo Mode)"
echo ""
echo "This will START migrating slot 500 from node-1 to node-2"
echo "The migration will be visible in the BetterDB Monitor until you complete it."
echo ""

# Get node IDs
NODE1_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "myself,master" | awk '{print $1}')
NODE2_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "valkey-node-2.*master" | awk '{print $1}')

echo " Migration details:"
echo "  Source: Node 1 (${NODE1_ID:0:12}...)"
echo "  Target: Node 2 (${NODE2_ID:0:12}...)"
echo "  Slot: 500"
echo ""

# First, add some keys to slot 500 so migration has data
echo " Adding test keys to slot 500..."
for i in {1..10}; do
    # Calculate a key that hashes to slot 500
    # We'll use keys with {tag} syntax to force slot
    docker exec valkey-node-1 valkey-cli set "{slot500}key$i" "value$i" > /dev/null
done
echo "  Added 10 test keys"
echo ""

read -p "Start migration? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted"
    exit 0
fi

echo ""
echo "Starting migration..."

# Mark slot as migrating on source
docker exec valkey-node-1 valkey-cli cluster setslot 500 migrating $NODE2_ID > /dev/null
echo "  Marked slot 500 as MIGRATING on node-1"

# Mark slot as importing on target
docker exec valkey-node-2 valkey-cli cluster setslot 500 importing $NODE1_ID > /dev/null
echo "  Marked slot 500 as IMPORTING on node-2"

echo ""
echo "Migration is now IN PROGRESS!"
echo ""
echo "Check your BetterDB Monitor:"
echo "  1. Go to: http://localhost:5173"
echo "  2. Navigate to: Cluster Overview tab"
echo "  3. Look at the 'Slot Migrations' card"
echo "  4. You should see: Slot 500 migrating from node-1 to node-2"
echo ""
echo "The migration is paused so you can see it in the UI."
echo ""
echo "To COMPLETE the migration, run:"
echo "  ./scripts/cluster/migrations/complete.sh"
echo ""
echo "To CANCEL the migration, run:"
echo "  ./scripts/cluster/migrations/cancel.sh"
