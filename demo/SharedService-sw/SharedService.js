const PROVIDER_REQUEST_TIMEOUT = 1000;

export class SharedService extends EventTarget {
  /** @type {string} */ #name;
  /** @type {Promise<string>} */ #clientId;
  /** @type {() => MessagePort|Promise<MessagePort>} */ #portProviderFunc;

  // This BroadcastChannel is used for client messaging. The provider
  // must have a separate BroadcastChannel in case the instance is
  // both client and provider.
  #clientChannel = new BroadcastChannel('SharedService');

  /** @type {AbortController} */ #onDeactivate;
  /** @type {AbortController} */ #onClose = new AbortController();

  // This is client state to track the provider. The provider state is
  // mostly managed within activate().
  /** @type {Promise<MessagePort>} */ #providerPort;
  /** @type {Map<string, { resolve, reject }>} */ providerCallbacks = new Map();
  #providerCounter = 0;

  /** @type {{ [method: string] : (...args: any) => Promise<*> }} */ proxy;

  /**
   * @param {string} name 
   * @param {() => MessagePort|Promise<MessagePort>} portProviderFunc 
   */
  constructor(name, portProviderFunc) {
    super();

    this.#name = name;
    this.#portProviderFunc = portProviderFunc;

    this.#clientId = this.#getClientId();

    // Connect to the current provider and future providers.
    this.#providerPort = this.#providerChange();
    this.#clientChannel.addEventListener('message', ({data}) => {
      if (data?.type === 'provider' && data?.sharedService === this.#name) {
        this.#closeProviderPort(this.#providerPort);
        this.#providerPort = this.#providerChange();
      }
    }, { signal: this.#onClose.signal });

    this.proxy = this.#createProxy();
  }

  activate() {
    if (this.#onDeactivate) return;

    // If we acquire the lock then we are the service provider.
    this.#onDeactivate = new AbortController();
    navigator.locks.request(
      `SharedService-${this.#name}`,
      { signal: this.#onDeactivate.signal },
      async () => {
        // Get the port to request ports.
        const port = await this.#portProviderFunc();
        port.start();

        // Listen for client requests. A separate BroadcastChannel
        // instance is necessary because we may be serving our own
        // request.
        const providerId = await this.#clientId;
        const broadcastChannel = new BroadcastChannel('SharedService');
        broadcastChannel.addEventListener('message', async ({data}) => {
          if (data?.type === 'request' && data?.sharedService === this.#name) {
            // Get a port to send to the client.
            const requestedPort = await new Promise(resolve => {
              port.addEventListener('message', event => {
                resolve(event.ports[0]);
              }, { once: true });
              port.postMessage(data.clientId);
            });

            // Attach a port and forward to the client via the service worker.
            const serviceWorker = await navigator.serviceWorker.ready;
            serviceWorker.active.postMessage(data, [requestedPort]);
          }
        }, { signal: this.#onDeactivate.signal });

        // Tell everyone that we are the new provider.
        broadcastChannel.postMessage({
          type: 'provider',
          sharedService: this.#name,
          providerId
        });

        // Release the lock only on user abort or context destruction.
        return new Promise((_, reject) => {
          this.#onDeactivate.signal.addEventListener('abort', () => {
            broadcastChannel.close();
            reject(this.#onDeactivate.signal.reason);
          });
        });
      });
  }

  deactivate() {
    this.#onDeactivate?.abort();
    this.#onDeactivate = null;
  }

  close() {
    this.deactivate();
    this.#onClose.abort();
    for (const { reject } of this.providerCallbacks.values()) {
      reject(new Error('SharedService closed'));
    }
  }

  async #getClientId() {
    // Getting the clientId from the service worker accomplishes two things:
    // 1. It gets the clientId for this context.
    // 2. It ensures that the service worker is ready.
    let clientId;
    while (!clientId) {
      clientId = await fetch('./clientId').then(response => {
        if (response.ok) {
          return response.text();
        }
        console.warn('service worker not ready, retrying...');
        return new Promise(resolve => setTimeout(resolve, 100));
      });
    }

    // Acquire a Web Lock named after the clientId. This lets other contexts
    // track this context's lifetime.
    await new Promise(resolve => {
      navigator.locks.request(clientId, () => new Promise(releaseLock => {
        resolve();
        this.#onClose.signal.addEventListener('abort', releaseLock);
      }));
    });
    return clientId;
  }

  async #providerChange() {
    // Multiple calls to this function could be in flight at once. If that
    // happens, we only care about the most recent call, i.e. the one
    // assigned to this.#providerPort. This counter lets us determine
    // whether this call is still the most recent.
    const providerCounter = ++this.#providerCounter;

    // Obtain a MessagePort from the provider. The request can fail during
    // a provider transition, so retry until successful.
    /** @type {MessagePort} */ let providerPort;
    const clientId = await this.#clientId;
    while (!providerPort && providerCounter === this.#providerCounter) {
      const abortController = new AbortController();
      try {
        // Broadcast a request for the port.
        const nonce = randomString();
        this.#clientChannel.postMessage({
          type: 'request', nonce,
          sharedService: this.#name,
          clientId
        });

        // Wait for the provider to respond (via the service worker) or
        // timeout. A timeout can occur if there is no provider to receive
        // the broadcast or if the provider is too busy.
        const providerPortReady = new Promise(resolve => {
          navigator.serviceWorker.addEventListener('message', event => {
            if (event.data?.nonce === nonce) {
              resolve(event.ports[0]);
            }
          }, { signal: abortController.signal });
        });

        providerPort = await Promise.race([
          providerPortReady,
          new Promise(resolve => setTimeout(() => resolve(null), PROVIDER_REQUEST_TIMEOUT))
        ]);

        if (!providerPort) {
          // Close the port if it arrives after the timeout.
          providerPortReady.then(port => port?.close());
        }
      } catch (e) {
        console.warn(e);
      } finally {
        abortController.abort();
      }
    }

    if (providerPort && providerCounter === this.#providerCounter) {
      // Configure the port.
      providerPort.addEventListener('message', ({data}) => {
        const callbacks = this.providerCallbacks.get(data.nonce);
        if (data.result) {
          callbacks.resolve(data.result);
        } else {
          callbacks.reject(Object.assign(new Error(), data.error));
        }
      });
      providerPort.start();
      return providerPort;
    } else {
      providerPort?.close();
      return null;
    }
  }

  #closeProviderPort(providerPort) {
    providerPort.then(port => port?.close());
    for (const { reject } of this.providerCallbacks.values()) {
      reject(new Error('SharedService provider change'));
    }
  }

  #createProxy() {
    return new Proxy({}, {
      get: (_, method) => {
        return async (...args) => {
          // Use a nonce to match up requests and responses. This allows
          // the responses to be out of order.
          const nonce = randomString();

          const providerPort = await this.#providerPort;
          return new Promise((resolve, reject) => {
            this.providerCallbacks.set(nonce, { resolve, reject });
            providerPort.postMessage({ nonce, method, args });
          }).finally(() => {
            this.providerCallbacks.delete(nonce);
          });
        }
      }
    });
  }
}

/**
 * Wrap a target with MessagePort for proxying.
 * @param {{ [method: string]: (...args) => any }} target 
 * @returns 
 */
export function createSharedServicePort(target) {
  const { port1: providerPort1, port2: providerPort2 } = new MessageChannel();
  providerPort1.addEventListener('message', ({data: clientId}) => {
    const { port1, port2 } = new MessageChannel();

    // The port requester holds a lock while using the channel. When the
    // lock is released by the requester, clean up the port on this side.
    navigator.locks.request(clientId, () => {
      port1.close();
    });

    port1.addEventListener('message', async ({data}) => {
      const response = { nonce: data.nonce };
      try {
        response.result = await target[data.method](...data.args);
      } catch(e) {
        // Error is not structured cloneable so copy into POJO.
        const error = e instanceof Error ?
          Object.fromEntries(Object.getOwnPropertyNames(e).map(k => [k, e[k]])) :
          e;
        response.error = error;
      }
      port1.postMessage(response);
    });
    port1.start();
    providerPort1.postMessage(null, [port2]);
  });
  providerPort1.start();
  return providerPort2;
}

function randomString() {
  return Math.random().toString(36).replace('0.', '');
}