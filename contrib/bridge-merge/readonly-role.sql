CREATE ROLE bridge_merge_readonly LOGIN PASSWORD 'change-me';
GRANT CONNECT ON DATABASE whatsapp TO bridge_merge_readonly;
GRANT USAGE ON SCHEMA public TO bridge_merge_readonly;
GRANT SELECT ON portal, user_login, user_portal TO bridge_merge_readonly;
ALTER ROLE bridge_merge_readonly SET default_transaction_read_only = on;
