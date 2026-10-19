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
