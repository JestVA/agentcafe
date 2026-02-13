export class AgentCafeClient {
  constructor({ baseUrl }) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:3846").replace(/\/$/, "");
  }

  async #request(path, options = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok || (payload && payload.ok === false)) {
      const reason = payload?.error || `HTTP ${res.status}`;
      throw new Error(`AgentCafe request failed (${path}): ${reason}`);
    }

    return payload;
  }

  requestMenu() {
    return this.#request("/api/menu");
  }

  getState({ actorId } = {}) {
    const query = actorId ? `?actorId=${encodeURIComponent(actorId)}` : "";
    return this.#request(`/api/state${query}`);
  }

  enterCafe({ actorId } = {}) {
    return this.#request("/api/enter", {
      method: "POST",
      body: { actorId }
    });
  }

  move({ actorId, direction, steps = 1 }) {
    return this.#request("/api/move", {
      method: "POST",
      body: { actorId, direction, steps }
    });
  }

  say({ actorId, text, ttlMs }) {
    return this.#request("/api/say", {
      method: "POST",
      body: { actorId, text, ttlMs }
    });
  }

  orderCoffee({ actorId, itemId, size = "regular" }) {
    return this.#request("/api/order", {
      method: "POST",
      body: { actorId, itemId, size }
    });
  }

  getCurrentOrder({ actorId } = {}) {
    const query = actorId ? `?actorId=${encodeURIComponent(actorId)}` : "";
    return this.#request(`/api/order${query}`);
  }

  leaveCafe({ actorId } = {}) {
    return this.#request("/api/leave", {
      method: "POST",
      body: { actorId }
    });
  }
}
