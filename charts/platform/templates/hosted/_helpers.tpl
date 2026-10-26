{{/*
Hosted MCP servers (ADR 014). The gateway runs admin-added container images in a dedicated
namespace (hosted.namespace) through the Kubernetes API, as ServiceAccount <release>-gateway with a
Role limited to that namespace. These helpers name the pieces the gateway pod template, the RBAC
and the NetworkPolicies share.
*/}}
{{- define "platform.hosted.namespace" -}}
{{- .Values.hosted.namespace -}}
{{- end }}

{{- define "platform.gatewayServiceAccount" -}}
{{- include "platform.componentName" (dict "ctx" . "component" "gateway") -}}
{{- end }}

{{/* Labels of objects the chart creates in the hosted namespace. */}}
{{- define "platform.hosted.labels" -}}
{{- include "platform.labels" (dict "ctx" . "component" "hosted") }}
{{- end }}
