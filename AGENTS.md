# PiQ Harness

Keep the channel small: persist messages, aggregate a signal, and expose explicit sending.
Let Pi decide whether to read, reply, remember, or save assets. Do not forward normal assistant output.
Each conversation group owns one directory and one Pi Agent Session. Keep each member conversation's logs separate and use an explicit reply target. Read configuration from the current Pi context's cwd.
Human instructions belong in Markdown; conversation records belong in JSONL; credentials belong in environment variables.
Use the official @tencent-connect/qqbot-nodejs 1.0.5 SDK for QQ Open Platform access and retain its MIT notices. Do not add SnowLuma, OneBot, DSH, qqbot-connector, QR-login, or personal-account integration code. Credentials are supplied manually through QQBOT_APP_ID and QQBOT_APP_SECRET environment variables (or the names configured for the group). Official conversation and message IDs are opaque strings; do not convert them to numeric QQ IDs or migrate legacy workspaces automatically.
Use `npm run verify` before delivery. Tests must use temporary directories and simulated QQ endpoints.
Never send a real QQ message as a test.
