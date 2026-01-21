#!/bin/bash

# Cancel the ongoing slot migration

set -e

echo "Cancelling slot migration..."

# Get node IDs
NODE1_ID=$(docker exec valkey-node-1 valkey-cli cluster nodes | grep "myself,master" | awk '{print $1}')

# Cancel migration - slot stays with original owner (node-1)
docker exec valkey-node-1 valkey-cli cluster setslot 500 stable > /dev/null
docker exec valkey-node-2 valkey-cli cluster setslot 500 stable > /dev/null

echo "Migration cancelled!"
echo ""
echo "Slot 500 remains with node-1"
echo "The migration should disappear from the Slot Migrations card."
