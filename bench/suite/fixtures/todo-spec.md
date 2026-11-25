# To-do list

A single-page to-do list for the bench suite.

## What it does

- Type a task and press Add (or Enter) to append it to the list. Blank input adds nothing.
- Each item has a switch that marks it done; a done item shows struck through.
- "Clear done" removes every done item.
- A counter shows how many of the total are done.
- When the list is empty it shows "Nothing yet".

## Data

- Items live in memory only; nothing is stored between reloads.
- Each item has an id that increases, so two items added in a row never share an id.

## Not included

- No due dates, no sorting, no sync, no storage.
