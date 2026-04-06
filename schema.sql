-- PostgreSQL Schema for messages storage
CREATE TABLE messages (
  id SERIAL PRIMARY KEY,
  sender VARCHAR(255),
  recipient VARCHAR(255),
  content TEXT,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);