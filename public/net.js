export function connectNet(room, handlers, onClose) {
  const configured = window.TWO_LANE_WS_URL?.trim();
  const endpoint = configured || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
  const url = new URL(endpoint);
  url.searchParams.set('room', room);
  const ws = new WebSocket(url);
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handlers[msg.t]?.(msg);
  };
  ws.onclose = onClose;
  return {
    send(msg) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
  };
}
