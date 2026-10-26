// Store settings for tests: what the chart renders into MULTI_STORE_CONFIG for k3d.
import { StoreSettingsSchema, type StoreSettings } from '../../src/stores/settings.js';

export const SETTINGS: StoreSettings = StoreSettingsSchema.parse({
  domainSuffix: 'store.localtest.me',
  scheme: 'http',
  environmentType: 'local',
  woocommerce: { version: '11.0.1', currency: 'INR', defaultCountry: 'IN:DL' },
  apiUser: 'woo-mcp',
  images: {
    wordpress: { image: 'wordpress:6-php8.3-apache' },
    mariadb: { image: 'mariadb:11.4' },
    wpCli: { image: 'wordpress:cli-2.12.0-php8.3' },
    kubectl: { image: 'alpine/k8s:1.35.9' },
    wooMcp: { image: 'k3d-urumi-registry.localhost:5005/urumi-woo-mcp:dev', pullPolicy: 'Always' },
  },
  storageClass: 'local-path',
  storage: { mariadb: '1Gi', wordpress: '1Gi' },
  resources: {
    mariadb: {
      requests: { cpu: '25m', memory: '128Mi' },
      limits: { cpu: '500m', memory: '320Mi' },
    },
    wordpress: { requests: { cpu: '25m', memory: '96Mi' }, limits: { cpu: '1', memory: '384Mi' } },
    wooMcp: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
    wpCli: { requests: { cpu: '50m', memory: '96Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    kubectl: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
  },
  quota: {
    pods: '6',
    'requests.cpu': '300m',
    'requests.memory': '512Mi',
    'limits.cpu': '3',
    'limits.memory': '1536Mi',
    persistentvolumeclaims: '2',
    'requests.storage': '4Gi',
    'services.nodeports': '0',
    'services.loadbalancers': '0',
  },
  network: {
    gatewayNamespace: 'urumi',
    gatewayPodSelector: {
      matchLabels: { 'app.kubernetes.io/instance': 'urumi' },
      matchExpressions: [
        { key: 'app.kubernetes.io/component', operator: 'In', values: ['gateway'] },
      ],
    },
    ingressNamespace: 'kube-system',
    ingressPodLabels: { 'app.kubernetes.io/name': 'traefik' },
    dnsNamespace: 'kube-system',
    dnsPodLabels: { 'k8s-app': 'kube-dns' },
    kubeApi: { cidr: '0.0.0.0/0', ports: [443, 6443] },
    internet: {
      ports: [80, 443],
      except: [
        '10.0.0.0/8',
        '172.16.0.0/12',
        '192.168.0.0/16',
        '100.64.0.0/10',
        '169.254.0.0/16',
        '127.0.0.0/8',
      ],
    },
  },
  clusterRoles: { manager: 'urumi-store-manager', bootstrap: 'urumi-store-bootstrap' },
  gatewayServiceAccount: { name: 'urumi-gateway', namespace: 'urumi' },
});
