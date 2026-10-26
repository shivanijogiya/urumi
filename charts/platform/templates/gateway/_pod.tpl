{{/*
Pod template of a gateway Deployment, shared by the stable Deployment (deployment.yaml) and the
canary (canary-deployment.yaml, #23) so both always run the same spec. Only these differ:
  component   selector component label: `gateway` (stable) or `gateway-canary`
  track       `stable` | `canary`: pod label `track` and env TRACK (x-urumi-track header)
  image       "<repository>:<tag>"
  pullPolicy
  fault       dict errorRate/latencyMs: FAULT_INJECT_* env (forced-bad-release demo); nil = none
Usage: include "platform.gatewayPodTemplate" (dict "ctx" $ "component" "gateway" "track" "stable"
         "image" "…" "pullPolicy" "…" "fault" nil) | nindent 4
*/}}
{{- define "platform.gatewayPodTemplate" -}}
{{- $ := .ctx }}
{{- $v := $.Values.gateway }}
{{- $pg := $.Values.postgres -}}
metadata:
  labels:
    {{- include "platform.labels" (dict "ctx" $ "component" .component) | nindent 4 }}
    track: {{ .track }}
spec:
  automountServiceAccountToken: false
  {{- if include "platform.gatewayKubeAccess" $ }}
  # Hosted MCP servers (ADR 014): a Role in the hosted namespace; multiple stores (ADR 015): the
  # store ClusterRoles in templates/stores/rbac.yaml. The token is projected below (not automounted)
  # and only while either feature is on.
  serviceAccountName: {{ include "platform.gatewayServiceAccount" $ }}
  {{- end }}
  # Soft rules (ADR 010): spread replicas over nodes when possible, never block scheduling.
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                {{- include "platform.selectorLabels" (dict "ctx" $ "component" .component) | nindent 16 }}
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          {{- include "platform.selectorLabels" (dict "ctx" $ "component" .component) | nindent 10 }}
  securityContext:
    # node user of the node:22-alpine image.
    runAsUser: 1000
    runAsGroup: 1000
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: gateway
      image: {{ .image | quote }}
      imagePullPolicy: {{ .pullPolicy }}
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      ports:
        - name: http
          containerPort: 8080
        {{- if $v.metrics.enabled }}
        - name: metrics
          containerPort: {{ $v.metrics.port }}
        {{- end }}
      env:
        - name: PORT
          value: "8080"
        - name: PUBLIC_ORIGIN
          value: {{ $v.publicOrigin | quote }}
        - name: COOKIE_SECURE
          value: {{ $v.cookieSecure | quote }}
        # Migrations run on start; concurrent starts are serialised by an advisory lock.
        - name: PGHOST
          value: {{ include "platform.postgresHost" $ | quote }}
        - name: PGPORT
          value: {{ $v.database.port | quote }}
        - name: PGUSER
          value: {{ $pg.user | quote }}
        - name: PGDATABASE
          value: {{ $pg.database | quote }}
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.secretName }}
              key: {{ $pg.secretKeys.password }}
        {{- range $name, $key := $v.secretKeys }}
        - name: {{ $name }}
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.secretName }}
              key: {{ $key }}
        {{- end }}
        # In-cluster upstreams (woo-mcp, everything) resolve to private IPs; allow-list exactly
        # those Services. No wildcard: Postgres, MariaDB and WordPress stay blocked.
        {{- $upstreamHosts := list }}
        {{- range $component, $enabled := dict "woo-mcp" $.Values.wooMcp.enabled "everything" $.Values.everything.enabled }}
        {{- if $enabled }}
        {{- $upstreamHosts = append $upstreamHosts (printf "%s.%s.svc.cluster.local" (include "platform.componentName" (dict "ctx" $ "component" $component)) $.Release.Namespace) }}
        {{- end }}
        {{- end }}
        - name: UPSTREAM_ALLOWED_HOSTS
          value: {{ $v.upstreamAllowedHosts | default (join "," $upstreamHosts) | quote }}
        # Chat agent (C3). Optional: without the key the gateway runs and /api/chat answers 503.
        # Calls api.anthropic.com:443; no NetworkPolicy restricts gateway egress.
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.secretName }}
              key: {{ $v.chatSecretKey }}
              optional: true
        - name: CHAT_MODEL
          value: {{ $v.chatModel | quote }}
        - name: CHAT_DISCOVERY_THRESHOLD
          value: {{ $v.chatDiscoveryThreshold | int | quote }}
        # OAuth (ADR 013): extra private-use redirect URI schemes (https + loopback always allowed).
        - name: OAUTH_REDIRECT_SCHEMES
          value: {{ join "," ($v.oauth.extraRedirectSchemes | default list) | quote }}
        {{- if $.Values.wooMcp.enabled }}
        # The internal woo-mcp upstream (W3) and the header secret it requires.
        - name: WOO_MCP_URL
          value: {{ include "platform.wooMcpUrl" $ | quote }}
        - name: WOO_MCP_SHARED_SECRET
          valueFrom:
            secretKeyRef:
              name: {{ $.Values.secretName }}
              key: {{ $.Values.wooMcp.secretKeys.sharedSecret }}
        {{- end }}
        {{- with $.Values.hosted }}
        {{- if .enabled }}
        # Hosted MCP servers (ADR 014): Deployments/Services/Secrets in this namespace only.
        - name: HOSTED_ENABLED
          value: "true"
        - name: HOSTED_NAMESPACE
          value: {{ include "platform.hosted.namespace" $ | quote }}
        - name: HOSTED_SERVICE_ACCOUNT
          value: {{ .serviceAccountName | quote }}
        - name: HOSTED_ALLOWED_IMAGES
          value: {{ join "," (.allowedImages | default list) | quote }}
        - name: HOSTED_REQUIRE_DIGEST
          value: {{ .requireDigest | quote }}
        - name: HOSTED_MAX_SERVERS
          value: {{ .maxServers | int | quote }}
        {{- end }}
        {{- end }}
        {{- if $.Values.multiStore.enabled }}
        # Multiple stores (ADR 015): namespaces store-<slug>, confined by the store admission policy.
        - name: MULTI_STORE_ENABLED
          value: "true"
        - name: MULTI_STORE_MAX_STORES
          value: {{ $.Values.multiStore.maxStores | int | quote }}
        - name: MULTI_STORE_CONFIG
          value: {{ include "platform.stores.config" $ | quote }}
        {{- end }}
        {{- if $.Values.wordpress.enabled }}
        - name: BUILTIN_STORE_URL
          value: {{ include "platform.storeUrl" $ | quote }}
        - name: BUILTIN_STORE_NAME
          value: {{ $.Values.bootstrap.storeTitle | quote }}
        {{- end }}
        # Internal Prometheus listener (ADR 011); 0 = off.
        - name: METRICS_PORT
          value: {{ ternary $v.metrics.port 0 (and $v.metrics.enabled true) | quote }}
        # Several replicas (ADR 010): the pod name holds the health-loop lease; /mcp rate limits.
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        {{- with $v.rateLimit }}
        - name: MCP_RATE_LIMIT_KEY_PER_MIN
          value: {{ .perKey.perMinute | int | quote }}
        - name: MCP_RATE_LIMIT_KEY_BURST
          value: {{ .perKey.burst | int | quote }}
        - name: MCP_RATE_LIMIT_USER_PER_MIN
          value: {{ .perUser.perMinute | int | quote }}
        - name: MCP_RATE_LIMIT_USER_BURST
          value: {{ .perUser.burst | int | quote }}
        {{- end }}
        # Canary (#23): every response carries x-urumi-track: <track>.
        - name: TRACK
          value: {{ .track | quote }}
        {{- with .fault }}
        {{- if or .errorRate .latencyMs }}
        # FORCED BAD RELEASE (demo only): fail/delay this share of tools/call requests.
        - name: FAULT_INJECT_ERROR_RATE
          value: {{ .errorRate | default 0 | quote }}
        - name: FAULT_INJECT_LATENCY_MS
          value: {{ .latencyMs | default 0 | int | quote }}
        {{- end }}
        {{- end }}
      {{- with $v.preStopSleepSeconds }}
      # Keep serving while the Ingress removes this pod from its endpoints, then get SIGTERM.
      lifecycle:
        preStop:
          exec:
            command: ["sleep", {{ . | int | quote }}]
      {{- end }}
      # Startup waits for Postgres (up to 2 min) and runs migrations before listening.
      startupProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 5
        timeoutSeconds: 3
        failureThreshold: 36
      readinessProbe:
        httpGet:
          path: /readyz
          port: http
        periodSeconds: 10
        timeoutSeconds: 3
        failureThreshold: 3
      livenessProbe:
        httpGet:
          path: /healthz
          port: http
        periodSeconds: 20
        timeoutSeconds: 3
        failureThreshold: 3
      resources:
        {{- toYaml $v.resources | nindent 8 }}
      volumeMounts:
        # The root filesystem is read-only; give Node a writable /tmp.
        - name: tmp
          mountPath: /tmp
        {{- if $.Values.multiStore.enabled }}
        # Bootstrap scripts for store Jobs (same files as the built-in store's Job).
        - name: store-bootstrap
          mountPath: /etc/urumi/store-bootstrap
          readOnly: true
        {{- end }}
        {{- if include "platform.gatewayKubeAccess" $ }}
        - name: kube-api-access
          mountPath: /var/run/secrets/kubernetes.io/serviceaccount
          readOnly: true
        {{- end }}
  volumes:
    - name: tmp
      emptyDir:
        sizeLimit: 64Mi
    {{- if $.Values.multiStore.enabled }}
    - name: store-bootstrap
      configMap:
        name: {{ include "platform.componentName" (dict "ctx" $ "component" "bootstrap") }}
    {{- end }}
    {{- if include "platform.gatewayKubeAccess" $ }}
    # Short-lived token (rotated by the kubelet; the gateway re-reads it per request) + cluster CA.
    - name: kube-api-access
      projected:
        defaultMode: 0444
        sources:
          - serviceAccountToken:
              path: token
              expirationSeconds: 3600
          - configMap:
              name: kube-root-ca.crt
              items:
                - key: ca.crt
                  path: ca.crt
    {{- end }}
{{- end }}

{{/*
podSelector (matchLabels + matchExpressions) for "this release's gateway pods": the stable
Deployment, plus the canary while gatewayCanary.enabled. Used by the NetworkPolicies of the
components only the gateway may reach. Usage: include "platform.gatewayPeerSelector" . | nindent N
*/}}
{{- define "platform.gatewayPeerSelector" -}}
matchLabels:
  app.kubernetes.io/instance: {{ .Release.Name }}
matchExpressions:
  - key: app.kubernetes.io/component
    operator: In
    values:
      - gateway
      {{- if .Values.gatewayCanary.enabled }}
      - gateway-canary
      {{- end }}
{{- end }}
