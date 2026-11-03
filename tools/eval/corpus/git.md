# Git recipes

Everyday Git commands, with the ones that rescue mistakes first.

## Undo the last commit

git reset --soft HEAD~1 moves the branch back one commit and keeps the changes staged.
git reset --hard HEAD~1 throws the changes away, so only use it when you are sure.
To change only the message of the last commit, use git commit --amend.

## Stash

git stash saves uncommitted work and gives you a clean working tree.
git stash list shows what is saved, git stash pop brings the latest back,
and git stash push -m "wip parser" names an entry.

## Branches

git switch -c feature/login creates a branch and moves to it.
git branch -d old-branch deletes a merged branch; -D forces it.
git branch -vv shows which remote branch each local one tracks.

## Rebase

git rebase main replays your branch on top of main for a straight history.
If a conflict stops it, fix the files, git add them, then git rebase --continue,
or give up with git rebase --abort.

## Find the commit that broke it

git bisect start, then git bisect bad on the broken commit and git bisect good on an old good one.
Git checks out the midpoint each time; mark it good or bad until it names the culprit.
Finish with git bisect reset.
