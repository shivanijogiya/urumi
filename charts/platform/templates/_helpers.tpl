{{/* Chart name, overridable with nameOverride. */}}
{{- define "platform.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Resource name prefix: fullnameOverride, else the release name. */}}
{{- define "platform.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Name of one component's resources, e.g. urumi-mariadb.
Usage: include "platform.componentName" (dict "ctx" $ "component" "mariadb")
*/}}
{{- define "platform.componentName" -}}
{{- printf "%s-%s" (include "platform.fullname" .ctx) .component | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Selector labels for one component (stable; never add mutable labels here).
Usage: include "platform.selectorLabels" (dict "ctx" $ "component" "mariadb")
*/}}
{{- define "platform.selectorLabels" -}}
app.kubernetes.io/name: {{ include "platform.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Full label set for one component.
Usage: include "platform.labels" (dict "ctx" $ "component" "mariadb")
*/}}
{{- define "platform.labels" -}}
{{ include "platform.selectorLabels" . }}
app.kubernetes.io/part-of: {{ include "platform.name" .ctx }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version | replace "+" "_" }}
{{- end }}

{{/* Store base URL: store.url, else http(s)://store.host. */}}
{{- define "platform.storeUrl" -}}
{{- if .Values.store.url }}
{{- .Values.store.url | trimSuffix "/" }}
{{- else }}
{{- printf "%s://%s" (ternary "https" "http" .Values.store.tls.enabled) .Values.store.host }}
{{- end }}
{{- end }}

{{/* host:port WordPress uses for the database. */}}
{{- define "platform.wordpressDbHost" -}}
{{- default (printf "%s:3306" (include "platform.componentName" (dict "ctx" . "component" "mariadb"))) .Values.wordpress.databaseHost }}
{{- end }}

{{/*
Env that the official image's wp-config.php reads (DB connection + WORDPRESS_CONFIG_EXTRA).
Shared by the WordPress Deployment and the bootstrap Job's WP-CLI container so both see the
same site. Usage: include "platform.wordpressEnv" . | nindent 12
*/}}
{{- define "platform.wordpressEnv" -}}
{{- $url := include "platform.storeUrl" . -}}
- name: WORDPRESS_DB_HOST
  value: {{ include "platform.wordpressDbHost" . | quote }}
- name: WORDPRESS_DB_NAME
  value: {{ .Values.mariadb.database | quote }}
- name: WORDPRESS_DB_USER
  value: {{ .Values.mariadb.user | quote }}
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.secretName }}
      key: {{ .Values.mariadb.secretKeys.password }}
# Pin the public URL so WordPress never builds links from the request's Host header.
# Application Passwords need HTTPS unless the environment type is `local`.
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    define('WP_HOME', {{ $url | squote }});
    define('WP_SITEURL', {{ $url | squote }});
    define('WP_ENVIRONMENT_TYPE', {{ .Values.bootstrap.environmentType | squote }});
{{- end }}

{{/* Postgres host the gateway connects to: gateway.database.host, else the chart's Postgres Service. */}}
{{- define "platform.postgresHost" -}}
{{- default (include "platform.componentName" (dict "ctx" . "component" "postgres")) .Values.gateway.database.host }}
{{- end }}

{{/* Base URL the gateway side uses for the WooCommerce REST API: bootstrap.wooUrl, else the in-cluster WordPress Service. */}}
{{- define "platform.wooUrl" -}}
{{- if .Values.bootstrap.wooUrl }}
{{- .Values.bootstrap.wooUrl | trimSuffix "/" }}
{{- else }}
{{- printf "http://%s.%s.svc.cluster.local" (include "platform.componentName" (dict "ctx" . "component" "wordpress")) .Release.Namespace }}
{{- end }}
{{- end }}
