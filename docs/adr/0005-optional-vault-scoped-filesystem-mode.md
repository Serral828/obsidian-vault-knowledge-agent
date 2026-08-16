# Make direct filesystem capability optional and Vault-scoped

The model will use constrained Vault tools by default. Users may explicitly enable a stronger Vault Filesystem Mode, but that mode remains confined to the current Vault, exposes no shell execution, and still converts every write into a confirmed Change Proposal; this preserves advanced batch workflows without turning the plugin into a general computer agent.
