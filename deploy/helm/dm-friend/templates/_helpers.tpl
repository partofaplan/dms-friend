{{/*
Chart name, truncated to the 63-char DNS label limit.
*/}}
{{- define "dm-friend.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name.
*/}}
{{- define "dm-friend.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "dm-friend.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "dm-friend.labels" -}}
helm.sh/chart: {{ include "dm-friend.chart" . }}
{{ include "dm-friend.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "dm-friend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "dm-friend.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the Secret holding OPENAI_API_KEY: the existing one if provided, else the templated one.
*/}}
{{- define "dm-friend.secretName" -}}
{{- if .Values.openai.existingSecret }}
{{- .Values.openai.existingSecret }}
{{- else }}
{{- printf "%s-openai" (include "dm-friend.fullname" .) }}
{{- end }}
{{- end }}
