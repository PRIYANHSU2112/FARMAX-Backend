-- Runs once, on an empty Postgres volume (docker-entrypoint-initdb.d).
-- One Postgres instance, one database per service. A service never reads another service's database.
-- Add a line here when a new service is created (see services/_template).

CREATE DATABASE farmx_auth;
