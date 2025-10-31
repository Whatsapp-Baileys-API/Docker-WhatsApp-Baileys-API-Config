-- This script will be run automatically by the Postgres container
-- the first time it is created.

-- Creates a simple key-value store for auth credentials
-- We use this instead of the file system
CREATE TABLE IF NOT EXISTS baileys_auth_store (
    key_id VARCHAR(255) PRIMARY KEY,
    key_data JSONB NOT NULL
);

-- Creates the store for messages, replacing our in-memory Map
-- This is used for the getMessage() function
CREATE TABLE IF NOT EXISTS baileys_message_store (
    message_id VARCHAR(255) PRIMARY KEY,
    message_data JSONB NOT NULL,
    -- Add an index for faster lookups
    created_at TIMESTAMPTZ DEFAULT NOW() -- <-- FIXED THE TYPO HERE
);

-- You can add any other initialization logic here
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

