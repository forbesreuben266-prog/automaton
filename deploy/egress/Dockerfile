# Allowlisting HTTPS egress proxy. The agent container has no route to the
# internet except through this proxy, which only permits CONNECT to the
# hosts listed in `allowlist`.
ARG ALPINE_IMAGE=alpine:3.20
FROM ${ALPINE_IMAGE}
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY allowlist /etc/tinyproxy/allowlist
USER tinyproxy
EXPOSE 8888
ENTRYPOINT ["tinyproxy", "-d", "-c", "/etc/tinyproxy/tinyproxy.conf"]
