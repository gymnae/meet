// api.js
// JSON POSTs to this server, sent as text/plain so they stay "simple" requests without a CORS
// preflight. Corporate web gateways can bounce API calls through their own host and back (a
// cookie check that appends e.g. ?_sm_nck=1). After that detour the browser treats the call as
// cross-origin, and a preflight fails the gateway's check again, so the request never arrives.
// server.js parses text/plain bodies as JSON and allows the returning response to be read.
export function postJson(url, data) {
    return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(data)
    });
}
