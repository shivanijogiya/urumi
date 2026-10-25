{{/*
Namespace-wide NetworkPolicies (brief item 6): default deny for ingress AND egress, plus one allow
policy per real flow. Toggled by networkPolicy.enabled. The per-component ingress policies for
woo-mcp, everything and Postgres (templates/<component>/networkpolicy.yaml) stay as they are.
*/}}

{{/* podSelector matchLabels for one component of this release. */}}
{{- define "platform.np.component" -}}
matchLabels:
  {{- include "platform.selectorLabels" (dict "ctx" .ctx "component" .component) | nindent 2 }}
{{- end }}

{{/* Peer: pods of one component of this release (same namespace). */}}
{{- define "platform.np.peer" -}}
- podSelector:
    {{- include "platform.np.component" . | nindent 4 }}
{{- end }}

{{/* Peer: the ingress controller's pods (Traefik in kube-system on k3s). */}}
{{- define "platform.np.ingressControllerPeer" -}}
{{- $ic := .Values.networkPolicy.ingressController -}}
- namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: {{ $ic.namespace }}
  podSelector:
    matchLabels:
      {{- toYaml $ic.podLabels | nindent 6 }}
{{- end }}

{{/* Egress rule: public internet on networkPolicy.internet.ports, private ranges excluded. */}}
{{- define "platform.np.internetEgress" -}}
{{- $net := .Values.networkPolicy.internet -}}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- toYaml $net.except | nindent 10 }}
  ports:
    {{- range $net.ports }}
    - protocol: TCP
      port: {{ . }}
    {{- end }}
{{- end }}
