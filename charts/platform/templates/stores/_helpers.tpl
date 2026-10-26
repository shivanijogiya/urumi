{{/*
Multiple stores (ADR 015). The gateway provisions stores in namespaces `store-<slug>` through the
Kubernetes API as ServiceAccount <release>-gateway. These helpers name the cluster-scoped RBAC
objects and render the JSON settings the gateway reads from MULTI_STORE_CONFIG.
*/}}
{{- define "platform.stores.prefix" -}}
{{- include "platform.fullname" . -}}
{{- end }}
{{- define "platform.stores.provisionerRole" -}}
{{- printf "%s-store-provisioner" (include "platform.stores.prefix" .) -}}
{{- end }}
{{- define "platform.stores.managerRole" -}}
{{- printf "%s-store-manager" (include "platform.stores.prefix" .) -}}
{{- end }}
{{- define "platform.stores.bootstrapRole" -}}
{{- printf "%s-store-bootstrap" (include "platform.stores.prefix" .) -}}
{{- end }}

{{/* True ("true") when the gateway needs Kubernetes API access: hosted servers or stores. */}}
{{- define "platform.gatewayKubeAccess" -}}
{{- if or .Values.hosted.enabled .Values.multiStore.enabled }}true{{ end -}}
{{- end }}

{{/* MULTI_STORE_CONFIG: validated by apps/gateway/src/stores/settings.ts (strict). */}}
{{- define "platform.stores.config" -}}
{{- $m := .Values.multiStore -}}
{{- $b := .Values.bootstrap -}}
{{- $np := .Values.networkPolicy -}}
{{- $img := dict
  "wordpress" (dict "image" (printf "%s:%s" .Values.wordpress.image.repository .Values.wordpress.image.tag) "pullPolicy" .Values.wordpress.image.pullPolicy)
  "mariadb" (dict "image" (printf "%s:%s" .Values.mariadb.image.repository .Values.mariadb.image.tag) "pullPolicy" .Values.mariadb.image.pullPolicy)
  "wpCli" (dict "image" (printf "%s:%s" $b.wpCli.image.repository $b.wpCli.image.tag) "pullPolicy" $b.wpCli.image.pullPolicy)
  "kubectl" (dict "image" (printf "%s:%s" $b.kubectl.image.repository $b.kubectl.image.tag) "pullPolicy" $b.kubectl.image.pullPolicy)
  "wooMcp" (dict "image" (printf "%s:%s" .Values.wooMcp.image.repository (.Values.wooMcp.image.tag | default .Chart.AppVersion)) "pullPolicy" .Values.wooMcp.image.pullPolicy)
-}}
{{- $gwSel := include "platform.gatewayPeerSelector" . | fromYaml -}}
{{- $cfg := dict
  "domainSuffix" $m.domainSuffix
  "scheme" $m.scheme
  "tlsSecretName" $m.tlsSecretName
  "ingressClassName" .Values.ingress.className
  "provisionTimeoutMinutes" ($m.provisionTimeoutMinutes | int)
  "environmentType" $b.environmentType
  "forwardedProto" (.Values.wooMcp.forwardedProto | default "")
  "woocommerce" $b.woocommerce
  "apiUser" $b.apiUser
  "images" $img
  "storageClass" $m.persistence.storageClass
  "storage" (dict "mariadb" $m.persistence.mariadb "wordpress" $m.persistence.wordpress)
  "resources" $m.resources
  "quota" $m.quota
  "wordpressInternetEgress" $np.wordpressInternetEgress
  "network" (dict
    "gatewayNamespace" .Release.Namespace
    "gatewayPodSelector" $gwSel
    "ingressNamespace" $np.ingressController.namespace
    "ingressPodLabels" $np.ingressController.podLabels
    "dnsNamespace" $np.dns.namespace
    "dnsPodLabels" $np.dns.podLabels
    "kubeApi" $np.kubeApi
    "internet" $np.internet)
  "clusterRoles" (dict "manager" (include "platform.stores.managerRole" .) "bootstrap" (include "platform.stores.bootstrapRole" .))
  "gatewayServiceAccount" (dict "name" (include "platform.gatewayServiceAccount" .) "namespace" .Release.Namespace)
-}}
{{- toJson $cfg -}}
{{- end }}
