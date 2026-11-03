# Regular expressions

Patterns and syntax that work in JavaScript, Python and PowerShell alike.

## Groups

Parentheses capture: (\d{4})-(\d{2}) puts the year in group 1 and the month in group 2.
(?:...) groups without capturing, and (?<year>\d{4}) names a group.

## Lookahead and lookbehind

foo(?=bar) matches foo only when bar follows, without consuming bar.
(?<!\$)\d+ matches digits not preceded by a dollar sign. Negative forms use ! instead of =.

## Greedy and lazy

.* takes as much as it can; .*? takes as little as possible.
<.+?> matches one HTML tag at a time instead of everything from the first < to the last >.

## Anchors and flags

^ and $ anchor to the start and end, or to each line with the m flag.
i ignores case, s lets the dot match newlines, and g finds every match in JavaScript.
