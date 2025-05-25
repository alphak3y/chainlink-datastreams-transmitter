#!/bin/sh

# Wait for Redis to be ready
echo "Waiting for Redis to be ready..."
until redis-cli -h transmitter-redis -a redis1234567890 ping; do
  sleep 1
done

# Clear Redis store
echo "Clearing Redis store..."
redis-cli -h transmitter-redis -a redis1234567890 FLUSHALL

# Start the application
echo "Starting application..."
npm start 