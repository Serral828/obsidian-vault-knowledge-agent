# Send only retrieved context to cloud models

Cloud Model Services will receive only the question, minimal relevant Task Session history, and a locally selected subset of Vault Evidence. The plugin will never upload the complete Vault or Knowledge Index and will let users inspect the Shared Context before transmission, limiting disclosure while preserving grounded answers.
