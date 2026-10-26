// Minimal Kubernetes API client for the hosted-server reconciler (ADR 014). No client library: the
// gateway needs six calls, all in ONE namespace, so it speaks HTTPS to the API server directly with
// the pod's projected ServiceAccount token (re-read on every request: the kubelet rotates it) and
// the cluster CA. Objects are written with server-side apply (PATCH application/apply-patch+yaml,
// one field manager, force), which is idempotent: two gateway replicas applying the same manifest
// converge on the same object. Authorization lives in the chart's Role, which allows only
// Deployments/Services/Secrets (write) and Pods (read) in the hosted namespace.
//
// Errors carry the HTTP status and the API's own short Status reason/message (no request body, no
// token); a missing object on delete is success.
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import type { KubeObject } from './manifests.js';
import { FIELD_MANAGER } from './manifests.js';

export const SA_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
export const KUBE_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type Kind = KubeObject['kind'];

/** The subset of a Deployment the reconciler reads. */
export interface DeploymentStatus {
  metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string> };
  status?: {
    availableReplicas?: number;
    readyReplicas?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

export interface ContainerStatus {
  name: string;
  ready?: boolean;
  restartCount?: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string; exitCode?: number };
    running?: object;
  };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
}

export interface PodStatus {
  metadata: { name: string; deletionTimestamp?: string };
  status?: {
    phase?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: ContainerStatus[];
  };
}

/** What the reconciler needs; HttpKubeApi in the cluster, an in-memory fake in tests. */
export interface KubeApi {
  apply(obj: KubeObject): Promise<void>;
  delete(kind: Kind, name: string): Promise<void>;
  getDeployment(name: string): Promise<DeploymentStatus | null>;
  listDeployments(labelSelector: string): Promise<DeploymentStatus[]>;
  listPods(labelSelector: string): Promise<PodStatus[]>;
}

export class KubeError extends Error {
  override name = 'KubeError';
  constructor(
    readonly status: number,
    /** Short and safe to store as a hosted server's reason. */
    readonly detail: string,
  ) {
    super(detail);
  }
}

const PATHS: Record<Kind, (ns: string) => string> = {
  Deployment: (ns) => `/apis/apps/v1/namespaces/${ns}/deployments`,
  Service: (ns) => `/api/v1/namespaces/${ns}/services`,
  Secret: (ns) => `/api/v1/namespaces/${ns}/secrets`,
};

export interface HttpKubeApiOptions {
  namespace: string;
  /** KUBERNETES_SERVICE_HOST / _PORT. */
  host: string;
  port: number;
  /** Directory with `token` and `ca.crt`. Default: the in-pod ServiceAccount mount. */
  saDir?: string;
  timeoutMs?: number;
}

export class HttpKubeApi implements KubeApi {
  private ca: Promise<Buffer> | undefined;
  constructor(private readonly opts: HttpKubeApiOptions) {}

  async apply(obj: KubeObject): Promise<void> {
    if (obj.metadata.namespace !== this.opts.namespace) {
      throw new KubeError(0, 'Refusing to write outside the hosted namespace');
    }
    const path = `${PATHS[obj.kind](this.opts.namespace)}/${obj.metadata.name}?fieldManager=${FIELD_MANAGER}&force=true`;
    await this.call('PATCH', path, JSON.stringify(obj), 'application/apply-patch+yaml');
  }

  async delete(kind: Kind, name: string): Promise<void> {
    const path = `${PATHS[kind](this.opts.namespace)}/${encodeURIComponent(name)}?propagationPolicy=Background`;
    try {
      await this.call('DELETE', path);
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return;
      throw err;
    }
  }

  async getDeployment(name: string): Promise<DeploymentStatus | null> {
    try {
      return (await this.call(
        'GET',
        `${PATHS.Deployment(this.opts.namespace)}/${encodeURIComponent(name)}`,
      )) as DeploymentStatus;
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return null;
      throw err;
    }
  }

  async listDeployments(labelSelector: string): Promise<DeploymentStatus[]> {
    const res = (await this.call(
      'GET',
      `${PATHS.Deployment(this.opts.namespace)}?labelSelector=${encodeURIComponent(labelSelector)}`,
    )) as { items?: DeploymentStatus[] };
    return res.items ?? [];
  }

  async listPods(labelSelector: string): Promise<PodStatus[]> {
    const res = (await this.call(
      'GET',
      `/api/v1/namespaces/${this.opts.namespace}/pods?labelSelector=${encodeURIComponent(labelSelector)}`,
    )) as { items?: PodStatus[] };
    return res.items ?? [];
  }

  private call(
    method: 'GET' | 'PATCH' | 'DELETE',
    path: string,
    body?: string,
    contentType?: string,
  ): Promise<unknown> {
    this.ca ??= readFile(`${this.opts.saDir ?? SA_DIR}/ca.crt`);
    return kubeRequest(
      { ...this.opts, ca: this.ca },
      { method, path, ...(body ? { body } : {}), ...(contentType ? { contentType } : {}) },
    );
  }
}

/** Where and how to reach the API server; shared by the hosted and the store clients. */
export interface KubeTransport {
  host: string;
  port: number;
  /** Directory with `token` (re-read per request) and `ca.crt`. */
  saDir?: string;
  /** The CA, read once by the caller. */
  ca: Promise<Buffer>;
  timeoutMs?: number;
}

/**
 * One HTTPS request to the API server with the projected ServiceAccount token: 5 s timeout, 4 MiB
 * response cap, JSON in and out. Errors are KubeErrors carrying the HTTP status and the API's own
 * short reason (never the token or the request body).
 */
export async function kubeRequest(
  t: KubeTransport,
  req: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: string;
    contentType?: string;
  },
): Promise<unknown> {
  const dir = t.saDir ?? SA_DIR;
  const [ca, token] = await Promise.all([
    t.ca,
    readFile(`${dir}/token`, 'utf8').then((v) => v.trim()),
  ]);
  const timeoutMs = t.timeoutMs ?? KUBE_TIMEOUT_MS;
  const { method, path, body, contentType } = req;
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: t.host,
        port: t.port,
        method,
        path,
        ca,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body
            ? {
                'content-type': contentType ?? 'application/json',
                'content-length': Buffer.byteLength(body),
              }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY_BYTES) r.destroy(new KubeError(0, 'Kubernetes API response too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* non-JSON error page */
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(json);
          reject(new KubeError(status, statusDetail(status, json)));
        });
      },
    );
    r.on('timeout', () => r.destroy(new KubeError(0, 'Kubernetes API timed out')));
    r.on('error', (err) =>
      reject(
        err instanceof KubeError
          ? err
          : new KubeError(
              0,
              `Kubernetes API unreachable (${(err as NodeJS.ErrnoException).code ?? 'error'})`,
            ),
      ),
    );
    if (body) r.write(body);
    r.end();
  });
}

/** `HTTP 403 Forbidden: <API message, 200 chars>`; the API's messages name objects, not secrets. */
export function statusDetail(status: number, json: unknown): string {
  const s = (json ?? {}) as { reason?: unknown; message?: unknown };
  const reason = typeof s.reason === 'string' ? ` ${s.reason}` : '';
  const message =
    typeof s.message === 'string' ? `: ${s.message.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return `Kubernetes API HTTP ${status}${reason}${message}`;
}
