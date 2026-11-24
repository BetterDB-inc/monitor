{{- define "betterdb-openeverest.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "betterdb-openeverest.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "betterdb-openeverest.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "betterdb-openeverest.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "betterdb-openeverest.selectorLabels" -}}
app.kubernetes.io/name: {{ include "betterdb-openeverest.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Image reference. An empty tag resolves to the chart's appVersion, the agent
release that carries the openeverest mode.
*/}}
{{- define "betterdb-openeverest.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository (toString $tag) -}}
{{- end -}}

{{- define "betterdb-openeverest.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "betterdb-openeverest.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Secret holding the BetterDB url and token. The backend reads it through the
API (so the settings panel can change it without a rollout) and writes it from
the panel. Bring-your-own existingSecret replaces the chart-managed one.
*/}}
{{- define "betterdb-openeverest.settingsSecretName" -}}
{{- default (printf "%s-settings" (include "betterdb-openeverest.fullname" .)) .Values.betterdb.existingSecret -}}
{{- end -}}

{{/*
Whether the chart renders the settings Secret: only with inline values (url
or token). With nothing set the backend creates it on the first save from
the settings panel, so a helm upgrade never clobbers what the panel wrote.
*/}}
{{- define "betterdb-openeverest.createSettingsSecret" -}}
{{- if and (not .Values.betterdb.existingSecret) (or .Values.betterdb.url .Values.betterdb.token) -}}
true
{{- end -}}
{{- end -}}

{{/*
Secret and key holding the CA bundle for the BetterDB WebSocket: the
chart-managed one from betterdb.ca, or betterdb.existingCaSecret. Kept apart
from the settings Secret so it works with betterdb.existingSecret too.
*/}}
{{- define "betterdb-openeverest.caSecretName" -}}
{{- if .Values.betterdb.existingCaSecret.name -}}
{{- .Values.betterdb.existingCaSecret.name -}}
{{- else -}}
{{- printf "%s-ca" (include "betterdb-openeverest.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "betterdb-openeverest.caSecretKey" -}}
{{- default "ca.crt" .Values.betterdb.existingCaSecret.key -}}
{{- end -}}

{{- define "betterdb-openeverest.mountCa" -}}
{{- if or .Values.betterdb.ca .Values.betterdb.existingCaSecret.name -}}
true
{{- end -}}
{{- end -}}

{{/*
ConfigMap recording which instances are enabled; created by the backend.
*/}}
{{- define "betterdb-openeverest.targetsConfigMapName" -}}
{{- printf "%s-targets" (include "betterdb-openeverest.fullname" .) -}}
{{- end -}}

{{/*
Path of the CA bundle for the BetterDB WebSocket inside the container, or
empty when none is configured.
*/}}
{{- define "betterdb-openeverest.caFile" -}}
{{- if include "betterdb-openeverest.mountCa" . -}}
/etc/betterdb/ca/ca.crt
{{- else -}}
{{- .Values.betterdb.caFile -}}
{{- end -}}
{{- end -}}
