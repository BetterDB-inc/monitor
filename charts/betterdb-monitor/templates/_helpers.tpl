{{- define "betterdb-monitor.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "betterdb-monitor.fullname" -}}
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

{{- define "betterdb-monitor.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "betterdb-monitor.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "betterdb-monitor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "betterdb-monitor.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Image reference. An empty tag resolves to "<appVersion>-no-ai" - the standard
(no-AI-deps) image published for every release, matching Docker Hub's `latest`.
*/}}
{{- define "betterdb-monitor.image" -}}
{{- $tag := default (printf "%s-no-ai" .Chart.AppVersion) .Values.image.tag -}}
{{- /* toString so a numeric tag (image.tag: 8 or 0.39 unquoted -> YAML int/float) renders as a string, not a mangled %!s(...) */ -}}
{{- printf "%s:%s" .Values.image.repository (toString $tag) -}}
{{- end -}}

{{/*
Name of the chart-managed Secret (db password / storage URL / license key).
Only rendered when at least one of those values is set inline; bring-your-own
existingSecret references bypass it entirely.
*/}}
{{- define "betterdb-monitor.secretName" -}}
{{- printf "%s" (include "betterdb-monitor.fullname" .) -}}
{{- end -}}

{{/*
Whether the chart-managed Secret is needed at all.
*/}}
{{- define "betterdb-monitor.createSecret" -}}
{{- if or (and .Values.db.password (not .Values.db.existingSecret)) (and .Values.storage.url (not .Values.storage.existingSecret)) (and .Values.license.key (not .Values.license.existingSecret)) -}}
true
{{- end -}}
{{- end -}}
