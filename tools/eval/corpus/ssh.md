# SSH notes

Keys, config and tunnels for working on remote machines.

## Generate a key

ssh-keygen -t ed25519 -C "laptop" creates a key pair in ~/.ssh.
Copy the .pub file to the server's ~/.ssh/authorized_keys to log in without a password.

## Config file

Host entries in ~/.ssh/config save typing:
Host box, HostName 192.168.1.20, User cg, IdentityFile ~/.ssh/id_ed25519.
After that, ssh box is enough.

## Agent

ssh-agent holds unlocked keys so the passphrase is asked once. On Windows enable the
OpenSSH Authentication Agent service, then ssh-add ~/.ssh/id_ed25519.

## Port forwarding

ssh -L 8080:localhost:80 box makes the server's port 80 reachable at localhost:8080 here.
ssh -R 9000:localhost:3000 box does the reverse and exposes a local port on the server.

## Copy files

scp report.pdf box:/tmp/ copies one file to the server; scp -r box:/var/log/app ./logs copies a folder back.
