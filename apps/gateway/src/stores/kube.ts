// Kubernetes API client for the store provisioner (ADR 015). Same transport as the hosted client
// (hosted/kube.ts: plain HTTPS, projected ServiceAccount token re-read per request, 5 s timeout,
// 4 MiB cap, server-side apply with one field manager), more kinds, and one hard rule: it refuses to
// touch any namespace that is not `store-<slug>`, and a Namespace object it writes must carry the
// store label. The chart's admission policy enforces the same rule in the API server, so neither a
// bug here nor a stolen token can create, label or delete another namespace or bind a role there.
import { readFile } from 'node:fs/promises';
import { KubeError, kubeRequest, SA_DIR } from '../hosted/kube.js';
import type { StoreKind, StoreObject } from './manifests.js';
import { FIELD_MANAGER, LABEL_STORE, STORE_NAMESPACE_RE } from './names.js';

/** What the provisioner reads back (Deployment, StatefulSet, Job, Pod, Namespace…): loosely typed. */
export interface KubeItem {
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    deletionTimestamp?: string;
    creationTimestamp?: string;
  };
  spec?: Record<string, unknown>;
  status?: {
    phase?: string;
    readyReplicas?: number;
    availableReplicas?: number;
    succeeded?: number;
    failed?: number;
    active?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: ContainerState[];
    initContainerStatuses?: ContainerState[];
  };
}
export interface ContainerState {
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

export interface StoreKubeApi {
  /** Server-side apply (idempotent). */
  apply(obj: StoreObject): Promise<void>;
  /** POST; false if it already exists (409). Never updates an existing object. */
  createIfAbsent(obj: StoreObject): Promise<boolean>;
  get(kind: StoreKind | 'Pod', namespace: string, name: string): Promise<KubeItem | null>;
  list(kind: StoreKind | 'Pod', namespace: string, labelSelector?: string): Promise<KubeItem[]>;
  /** 404 = already gone = success. Namespaced objects: `namespace` is the store namespace. */
  delete(kind: StoreKind, namespace: string, name: string): Promise<void>;
  /** Store namespaces only (label selector is ANDed with the store label). */
  listNamespaces(labelSelector: string): Promise<KubeItem[]>;
}

const API: Record<StoreKind | 'Pod', { group: string; plural: string; cluster?: true }> = {
  Namespace: { group: '/api/v1', plural: 'namespaces', cluster: true },
  ResourceQuota: { group: '/api/v1', plural: 'resourcequotas' },
  LimitRange: { group: '/api/v1', plural: 'limitranges' },
  ServiceAccount: { group: '/api/v1', plural: 'serviceaccounts' },
  ConfigMap: { group: '/api/v1', plural: 'configmaps' },
  Secret: { group: '/api/v1', plural: 'secrets' },
  Service: { group: '/api/v1', plural: 'services' },
  PersistentVolumeClaim: { group: '/api/v1', plural: 'persistentvolumeclaims' },
  Pod: { group: '/api/v1', plural: 'pods' },
  NetworkPolicy: { group: '/apis/networking.k8s.io/v1', plural: 'networkpolicies' },
  Ingress: { group: '/apis/networking.k8s.io/v1', plural: 'ingresses' },
  RoleBinding: { group: '/apis/rbac.authorization.k8s.io/v1', plural: 'rolebindings' },
  StatefulSet: { group: '/apis/apps/v1', plural: 'statefulsets' },
  Deployment: { group: '/apis/apps/v1', plural: 'deployments' },
  Job: { group: '/apis/batch/v1', plural: 'jobs' },
};

export function assertStoreNamespace(ns: string | undefined): string {
  if (!ns || !STORE_NAMESPACE_RE.test(ns)) {
    throw new KubeError(0, 'Refusing to touch a namespace that is not a store namespace');
  }
  return ns;
}

/** Collection path of `kind` (in `ns` unless cluster-scoped). */
export function collectionPath(kind: StoreKind | 'Pod', ns: string): string {
  const a = API[kind];
  if (a.cluster) return `${a.group}/${a.plural}`;
  return `${a.group}/namespaces/${assertStoreNamespace(ns)}/${a.plural}`;
}

/** Checks an object before any write: store namespace only; a Namespace must be labelled. */
export function checkWritable(obj: StoreObject): void {
  if (obj.kind === 'Namespace') {
    assertStoreNamespace(obj.metadata.name);
    if (obj.metadata.labels[LABEL_STORE] !== 'true') {
      throw new KubeError(0, 'Refusing to write a namespace without the store label');
    }
  } else {
    assertStoreNamespace(obj.metadata.namespace);
  }
}

export interface HttpStoreKubeOptions {
  host: string;
  port: number;
  saDir?: string;
  timeoutMs?: number;
}

export class HttpStoreKubeApi implements StoreKubeApi {
  private ca: Promise<Buffer> | undefined;
  constructor(private readonly opts: HttpStoreKubeOptions) {}

  private call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: string, ct?: string) {
    this.ca ??= readFile(`${this.opts.saDir ?? SA_DIR}/ca.crt`);
    return kubeRequest(
      { ...this.opts, ca: this.ca },
      { method, path, ...(body ? { body } : {}), ...(ct ? { contentType: ct } : {}) },
    );
  }

  private objectPath(obj: Pick<StoreObject, 'kind' | 'metadata'>): string {
    const ns = obj.kind === 'Namespace' ? obj.metadata.name : (obj.metadata.namespace ?? '');
    return `${collectionPath(obj.kind, ns)}/${encodeURIComponent(obj.metadata.name)}`;
  }

  async apply(obj: StoreObject): Promise<void> {
    checkWritable(obj);
    await this.call(
      'PATCH',
      `${this.objectPath(obj)}?fieldManager=${FIELD_MANAGER}&force=true`,
      JSON.stringify(obj),
      'application/apply-patch+yaml',
    );
  }

  async createIfAbsent(obj: StoreObject): Promise<boolean> {
    checkWritable(obj);
    const ns = obj.kind === 'Namespace' ? obj.metadata.name : obj.metadata.namespace!;
    try {
      await this.call(
        'POST',
        `${collectionPath(obj.kind, ns)}?fieldManager=${FIELD_MANAGER}`,
        JSON.stringify(obj),
      );
      return true;
    } catch (err) {
      if (err instanceof KubeError && err.status === 409) return false;
      throw err;
    }
  }

  async get(kind: StoreKind | 'Pod', namespace: string, name: string): Promise<KubeItem | null> {
    const path =
      kind === 'Namespace'
        ? `${collectionPath(kind, '')}/${assertStoreNamespace(name)}`
        : `${collectionPath(kind, namespace)}/${encodeURIComponent(name)}`;
    try {
      return (await this.call('GET', path)) as KubeItem;
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return null;
      throw err;
    }
  }

  async list(kind: StoreKind | 'Pod', namespace: string, labelSelector?: string): Promise<KubeItem[]> {
    if (kind === 'Namespace') return this.listNamespaces(labelSelector ?? '');
    const q = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : '';
    const res = (await this.call('GET', `${collectionPath(kind, namespace)}${q}`)) as {
      items?: KubeItem[];
    };
    return res.items ?? [];
  }

  async delete(kind: StoreKind, namespace: string, name: string): Promise<void> {
    const path =
      kind === 'Namespace'
        ? `${collectionPath(kind, '')}/${assertStoreNamespace(name)}`
        : `${collectionPath(kind, namespace)}/${encodeURIComponent(name)}`;
    try {
      await this.call('DELETE', `${path}?propagationPolicy=Background`);
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) return;
      throw err;
    }
  }

  async listNamespaces(labelSelector: string): Promise<KubeItem[]> {
    const sel = [`${LABEL_STORE}=true`, labelSelector].filter(Boolean).join(',');
    const res = (await this.call(
      'GET',
      `/api/v1/namespaces?labelSelector=${encodeURIComponent(sel)}`,
    )) as { items?: KubeItem[] };
    // Belt and braces: only names that look like store namespaces.
    return (res.items ?? []).filter((n) => STORE_NAMESPACE_RE.test(n.metadata.name));
  }
}
