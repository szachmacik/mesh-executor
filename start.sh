#!/bin/bash
echo "Starting MESH daemons..."
bun run /app/healer.ts &
bun run /app/consumer.ts &
wait
