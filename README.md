# k8s-webapp — Git → GitHub Actions → GHCR → Argo CD → Kubernetes

A small, production-shaped web app (task board + pod info dashboard) with a complete
GitOps CI/CD pipeline. Zero npm dependencies, so the only supply chain is the Node base image.

```
 git push ──► GitHub Actions ──► test ─┬─► build ─► Trivy scan ─► push to GHCR
                                       └─► kustomize + kubeconform validate
                                                    │
               main branch ─► bump k8s/overlays/dev image tag ─► commit
               v1.2.3 tag  ─► (manual approval) ─► bump overlays/prod ─► commit
                                                    │
                      Argo CD (in-cluster) watches repo ─► syncs ─► rolling update
```

CI never holds cluster credentials — Argo CD pulls from Git. That works for a private
homelab cluster on 192.168.x.x that GitHub runners can't reach.

## Layout

| Path | What it is |
|---|---|
| `app/src/app.js` | HTTP server: UI, `/api/tasks` CRUD, `/api/info`, `/healthz`, `/readyz`, `/metrics` |
| `app/src/server.js` | Entry point with graceful SIGTERM handling (fail readiness → drain → exit) |
| `app/test/` | 8 tests using built-in `node:test` |
| `Dockerfile` | Multi-stage: `test` stage gates the build, `runtime` stage is non-root |
| `k8s/base/` | Deployment, Service, ConfigMap, HPA, PDB, Ingress, NetworkPolicy |
| `k8s/overlays/dev` | 1–3 replicas, NodePort **30080**, host `dev.webapp.local` |
| `k8s/overlays/prod` | 3–6 replicas, bigger requests, PDB minAvailable 2, host `webapp.local` |
| `argocd/applications.yaml` | Argo CD Applications for dev and prod (auto-sync, prune, self-heal) |
| `.github/workflows/ci-cd.yml` | The pipeline |

Hardening baked in: `runAsNonRoot`, read-only root FS, all capabilities dropped, seccomp
`RuntimeDefault`, namespaces labelled `pod-security.kubernetes.io/enforce: restricted`,
zero-downtime rollouts (`maxUnavailable: 0`), topology spread across nodes, startup/liveness/readiness probes.

## 1. Run locally

```bash
cd app && npm test && npm start        # http://localhost:8080
# or
docker build -t k8s-webapp . && docker run -p 8080:8080 k8s-webapp
```

## 2. Push to GitHub

```bash
# Replace the placeholder everywhere with your GitHub user/org (lowercase)
grep -rl YOUR_GITHUB_USER . | xargs sed -i 's/YOUR_GITHUB_USER/<your-user>/g'

git remote add origin https://github.com/<your-user>/k8s-webapp.git
git push -u origin main
```

Repo settings to make once:
- **Settings → Actions → General → Workflow permissions:** Read and write.
- **Settings → Environments:** create `dev` and `production`; add required reviewers to `production`.
- After the first image push, **Packages → k8s-webapp → Package settings:** make it public
  (or create an `imagePullSecret` in each namespace for a private image).

## 3. Prepare the cluster (once)

```bash
# metrics-server (needed by HPA). On kubeadm clusters with self-signed kubelet certs add --kubelet-insecure-tls
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# ingress-nginx (optional — dev is also reachable on NodePort 30080)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/baremetal/deploy.yaml

# Argo CD
kubectl create namespace argocd
kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n argocd port-forward svc/argocd-server 8443:443   # UI at https://localhost:8443

# Register the app
kubectl apply -n argocd -f argocd/applications.yaml
```

## 4. Ship

```bash
# Deploy to dev: just push to main
git commit -am "feat: something" && git push
#   → pipeline builds sha-abc1234, commits the tag into overlays/dev, Argo CD rolls it out
curl http://<any-node-ip>:30080/api/info

# Release to prod: tag it
git tag v1.0.0 && git push origin v1.0.0
#   → builds 1.0.0, waits for approval on the `production` environment, then deploys
```

## 5. Things to try (good for demos / CKA practice)

```bash
kubectl -n webapp-dev get pods -o wide -w                     # watch a rolling update
kubectl -n webapp-dev rollout history deploy/webapp
kubectl -n webapp-dev delete pod -l app.kubernetes.io/name=webapp   # self-healing
kubectl -n webapp-dev scale deploy/webapp --replicas=5        # Argo CD self-heal reverts drift
# Rollback the GitOps way: git revert the deploy(dev) commit and push
```

## Without Argo CD (push-based alternative)

If you'd rather have CI apply directly, run a **self-hosted GitHub runner** inside your
network, store a kubeconfig as a secret, and replace the commit step with:

```bash
kustomize build k8s/overlays/dev | kubectl apply -f -
kubectl -n webapp-dev rollout status deploy/webapp --timeout=120s
```

## Notes

- Tasks live in each pod's memory, on purpose: refresh and you'll see different pods
  (and different task lists) as the Service load-balances. Add Redis/Postgres for real persistence.
- Manifests are validated against Kubernetes **1.29** schemas in CI.
