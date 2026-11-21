
CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    trial_used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    expires_at INTEGER,
    status TEXT DEFAULT 'active',
    FOREIGN KEY (telegram_id) REFERENCES users(telegram_id)
);

CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    telegram_charge_id TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nft_items (
    id TEXT PRIMARY KEY,
    collection TEXT,
    gift_name TEXT,
    owner_username TEXT,
    owner_id INTEGER,
    premium INTEGER,
    gifts_count INTEGER,
    category TEXT,
    source TEXT,
    discovered_at INTEGER NOT NULL,
    status TEXT DEFAULT 'available'
);

CREATE TABLE IF NOT EXISTS reservations (
    nft_id TEXT PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    reserved_at INTEGER NOT NULL,
    FOREIGN KEY (nft_id) REFERENCES nft_items(id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user
ON subscriptions(telegram_id);

CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry
ON subscriptions(status, expires_at);

CREATE INDEX IF NOT EXISTS idx_nft_status
ON nft_items(status, category);
