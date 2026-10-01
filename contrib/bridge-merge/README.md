# MatrixBridgeMerge deployment files

| File                     | Purpose                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.example.yml`    | Runs the `linker` bot next to existing bridges, passing their database credentials as environment variables.                                                                  |
| `registration.yml`       | Appservice registration for the `linker` bot. Replace both tokens.                                                                                                            |
| `readonly-role.sql`      | Creates a PostgreSQL role that can only read the three tables MatrixBridgeMerge uses.                                                                                         |
| `verify-real-bridges.sh` | Starts the official mautrix-whatsapp and mautrix-signal releases so they create their own databases, then checks that MatrixBridgeMerge can read them and cannot change them. |
| `ui-demo/`               | Drives the compiled widget with sample data and saves screenshots to `ui-demo/screenshots/`.                                                                                  |

Configuration is described in [docs/setup/bridge-management.md](../../docs/setup/bridge-management.md).
