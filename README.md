# weel

A small reading-and-tracking app. You browse your own folder of articles, PDFs and notes, open one, and the timer logs how much time you spent on it. Weekly goals show whether you actually put the hours in.

## Why

I wanted one place where reading and time tracking are the same action. Most trackers ask you to remember to start a clock; here you open what you're learning and the clock follows. I also wanted everything to stay local — files on disk, no account, no server.

## Use it

Double-click `index.html`. It runs in Chrome, Edge, or Opera.

The first time you visit the library, pick the folder that holds your reading material. A typical layout:

```
weel/
  index.html
  entries/
    md/
    pdf/
    notes/
```

Nesting inside those folders is fine. The browser remembers the choice, so you only pick once.

Click a file to read it. Markdown renders inline, PDFs open in the built-in viewer, plain text and source files show as text, images inline. Hit `t` to start a timer; hit `t` again to stop and save a session. If the file has no topic yet, the app asks once, then remembers.

Add a topic from the **topics** tab and give it a weekly hour goal. The bar under each topic shows how close you are. Each topic's detail page lists every file you've read for it, with totals.

To create a new note, click **+ new file** in the library, pick a folder and type, name it, and you land in the editor. Markdown files (`.md`) get a small toolbar and `⌘B` / `⌘I` / `⌘K` shortcuts plus a preview toggle (`⌘/`). Plain text formats (`.txt`, `.log`, `.json`, `.csv`, `.yaml`, common source) open in a plain editor. `⌘S` saves.

## Keys

`t` start or stop the timer · `e` edit the current file · `r` open a random file · `n` new topic · `f` new file · `/` filter files · `Esc` back

## Data

Topics, sessions and entry-to-topic links live in your browser's localStorage. Files live on disk where you put them. The **data** tab exports everything to one JSON file you can keep as a backup or move to another machine. Clearing browser data wipes the tracker (not the files).

## Files

```
weel/
  index.html
  styles.css
  app.js
  entries/      your reading material
```

That's the whole app, now its time to lock the fuck in...
