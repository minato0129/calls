# ---------- 開発用: air でホットリロード(ソースはボリュームでマウント) ----------
FROM golang:1.25-alpine AS dev
WORKDIR /app
RUN go install github.com/air-verse/air@v1.67.0
EXPOSE 8080
# go.sum が無ければここで作られ、マウント先(手元の server/)にも残る
CMD ["sh", "-c", "go mod tidy && air -c .air.toml"]

# ---------- 本番用ビルド ----------
FROM golang:1.25-alpine AS build
WORKDIR /src
COPY . .
RUN go mod tidy && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/callsys .

FROM alpine:3.21 AS prod
# OIDC と Web Push は HTTPS で外部に出るので CA 証明書が必要
RUN apk add --no-cache ca-certificates
COPY --from=build /out/callsys /app/callsys
EXPOSE 8080
ENTRYPOINT ["/app/callsys"]
