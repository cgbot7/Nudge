# Docker cheat sheet

Commands I reach for when working with containers, images and compose on Windows.

## Containers

List running containers with docker ps, and add -a to include stopped ones.
Start a throwaway shell in an image with docker run --rm -it ubuntu bash.

```bash
docker container prune   # remove all stopped containers
docker rm -f web         # force remove one container, even if it is running
```

## Images

Images pile up fast. docker image prune removes dangling layers, and docker image prune -a
removes every image that no container uses. docker system df shows how much disk each kind uses.

## Volumes

Named volumes keep data after the container is gone. List them with docker volume ls,
inspect one with docker volume inspect pgdata, and remove unused ones with docker volume prune.
Bind mounts map a host folder instead: -v "C:/data:/data".

## Logs and exec

Follow the output of a container with docker logs -f --tail 100 web.
Open a shell inside a running container with docker exec -it web sh.

## Compose

docker compose up -d starts every service in compose.yaml in the background.
docker compose down stops and removes them; add -v to delete their volumes too.
docker compose logs -f api follows one service.
