# kubectl basics

Day to day commands for a Kubernetes cluster.

## Pods

kubectl get pods -n web lists the pods in one namespace; add -o wide to see the node each one runs on.
kubectl describe pod api-7c9 shows events, which explain most pods stuck in Pending or CrashLoopBackOff.

## Logs and shell

kubectl logs -f deploy/api follows the logs of a deployment, and --previous shows the crashed container's last run.
kubectl exec -it api-7c9 -- sh opens a shell inside a pod.

## Rollouts

kubectl rollout status deploy/api waits for a new version to finish, kubectl rollout undo deploy/api goes back
to the previous one, and kubectl rollout restart deploy/api restarts every pod.

## Contexts

kubectl config get-contexts lists the clusters you can talk to, and kubectl config use-context staging switches.
Check the current one with kubectl config current-context before deleting anything.
