const tls = require("tls");
const websocket = require("ws");
const fs = require("fs/promises");
const json = require("extract-json-from-string");

let vanity, mfa, config;
let auth, sw, ch, CONNECTION_POOL_SIZE;
const tlsConnections = [];
const vanityRequestCache = new Map();
const guilds = {};

let keep, patchRequestTemplate, messageRequestPrefix;

console.log("[STARTUP] Vanity sniper started");

async function loadConfig() {
    try {
        const configData = JSON.parse(await fs.readFile('config.json', 'utf8'));
        config = configData;
        auth = config.token;
        sw = config.guildId;
        ch = config.channelId;
        CONNECTION_POOL_SIZE = config.maxSockets || 5;
        
        keep = Buffer.from(`GET / HTTP/1.1\r\nHost: canary.discord.com\r\nConnection: keep-alive\r\n\r\n`);
        patchRequestTemplate = Buffer.from(`PATCH /api/v6/guilds/${sw}/vanity-url HTTP/1.1\r\nHost: canary.discord.com\r\nAuthorization: ${auth}\r\nUser-Agent: Mozilla/5.0\r\nX-Super-Properties: eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n`);
        messageRequestPrefix = Buffer.from(`POST /api/v9/channels/${ch}/messages HTTP/1.1\r\nHost: discord.com\r\nAuthorization: ${auth}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n`);
        
        console.log(`[CONFIG] Loaded - Guild: ${sw}, Channel: ${ch}, Sockets: ${CONNECTION_POOL_SIZE}`);
    } catch (err) {
        console.error("[CONFIG] Failed to load config.json:", err.message);
        process.exit(1);
    }
}

function patch(vanityCode) {
    if (vanityRequestCache.has(vanityCode)) return vanityRequestCache.get(vanityCode);
    const payload = JSON.stringify({ code: vanityCode });
    const payloadLength = Buffer.byteLength(payload);
    const requestBuffer = Buffer.concat([
        patchRequestTemplate,
        Buffer.from(`X-Discord-MFA-Authorization: ${mfa}\r\nContent-Length: ${payloadLength}\r\n\r\n${payload}`)
    ]);
    vanityRequestCache.set(vanityCode, requestBuffer);
    console.log(`[VANITY] Created patch request for: ${vanityCode}`);
    return requestBuffer;
}

function sendVanityRequests(vanityCode, reason) {
    vanity = vanityCode;
    const requestBuffer = patch(vanityCode);
    
    for (const conn of tlsConnections) {
        if (conn.writable) {
            if (conn.setPriority) conn.setPriority(0);
            conn.write(requestBuffer);
        }
    }
    
    console.log(`[SNIPE] Attempting to claim vanity "${vanityCode}" (${reason}) - ${tlsConnections.length} requests sent`);
}

function webs(token) {
    const ws = new websocket("wss://gateway-us-east1-b.discord.gg", {perMessageDeflate: false, handshakeTimeout: 5000});
    
    ws.onclose = () => setTimeout(() => webs(token), 10);
    ws.onerror = () => {};
    
    const authPayload = JSON.stringify({op: 2, d: {token, intents: 513, properties: {os: "linux", browser: "firefox", device: ""}}});
    const heartbeatPayload = JSON.stringify({op: 1, d: {}, s: null, t: "heartbeat"});
    
    ws.onmessage = async (message) => {
        const {d, op, t} = JSON.parse(message.data);
        
        if (t === "GUILD_UPDATE" && d && guilds[d.guild_id] && guilds[d.guild_id] !== d.vanity_url_code) {
            sendVanityRequests(guilds[d.guild_id], "guild update");
        }
        else if (t === "GUILD_DELETE") {
            const find = guilds[d.guild_id];
            if (find) {
                sendVanityRequests(find, "guild delete");
                delete guilds[d.guild_id];
            }
        }
        else if (t === "READY" && d && d.guilds) {
            for (let i = 0; i < d.guilds.length; i++) 
                if (d.guilds[i].vanity_url_code) guilds[d.guilds[i].id] = d.guilds[i].vanity_url_code;
            console.log(`[READY] Monitoring ${Object.keys(guilds).length} guilds with vanity URLs`);
        }
        else if (op === 10) {
            ws.send(authPayload);
            setInterval(() => ws.send(heartbeatPayload), d.heartbeat_interval);
        }
    };
}

function qwe() {
    console.log(`[TLS] Initializing connection pool (size: ${CONNECTION_POOL_SIZE})`);
    for (let i = 0; i < CONNECTION_POOL_SIZE; i++) tlsc();
}

function tlsc() {
    const connection = tls.connect({
        host: "canary.discord.com", port: 443, minVersion: "TLSv1.3",
        ciphers: "TLS_AES_128_GCM_SHA384:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256",
        rejectUnauthorized: false, servername: "canary.discord.com",
        ALPNProtocols: ['http/1.1'], session: null
    });
    
    connection.setNoDelay(true);
    connection.setKeepAlive(true, 1000);
    if (connection.setPriority) connection.setPriority(0);
    if (connection.socket && connection.socket.setNoDelay) connection.socket.setNoDelay(true);
    
    connection.on("error", () => {
        const idx = tlsConnections.indexOf(connection);
        if (idx !== -1) tlsConnections.splice(idx, 1);
        setImmediate(tlsc);
    });
    
    connection.on("end", () => {
        const idx = tlsConnections.indexOf(connection);
        if (idx !== -1) tlsConnections.splice(idx, 1);
        setImmediate(tlsc);
    });
    
    connection.on("secureConnect", () => {
        if (!tlsConnections.includes(connection)) {
            tlsConnections.push(connection);
            connection.write(keep);
        }
    });
    
    connection.on("data", (data) => {
        if (!data.includes('{') || !data.includes('}')) return;
        
        const ext = json(data.toString());
        if (!ext || ext.length === 0) return;
        
        const find = ext.find((e) => e.code) || ext.find((e) => e.message);
        if (find) {
            console.log(`[RESPONSE] Vanity ${vanity}: ${JSON.stringify(find)}`);
            const msgContent = `vanity = \`${vanity}\` \nresponse = \`${JSON.stringify(find)}\` \n\`feel zendroys\` ||@everyone||`;
            const requestBody = JSON.stringify({content: msgContent});
            const contentLength = Buffer.byteLength(requestBody);
            const fullRequest = Buffer.concat([
                messageRequestPrefix,
                Buffer.from(`Content-Length: ${contentLength}\r\n\r\n${requestBody}`)
            ]);
            
            if (connection.writable) connection.write(fullRequest);
        }
    });
    
    return connection;
}

async function mfa2() {
    try {
        const jsonData = JSON.parse(await fs.readFile('mfa.json', 'utf8'));
        const newToken = jsonData.mfaToken || jsonData.token || "";
        if (mfa !== newToken) {
            console.log("[MFA] Updated MFA token");
            mfa = newToken;
            vanityRequestCache.clear();
        }
    } catch (err) {
        console.log("[MFA] Failed to load MFA token:", err.message);
    }
}

async function main() {
    console.log("[INIT] Starting vanity sniper...");
    await loadConfig();
    await mfa2();
    qwe();
    webs(auth);
    console.log("[INIT] Setup complete");
    setInterval(mfa2, 10000);
}

setInterval(() => {
    for (const conn of tlsConnections) {
        if (conn.writable) conn.write(keep);
    }
}, 2000);

setImmediate(main);
