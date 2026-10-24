# OffGrid

Minimal Flask starter with a plain HTML, CSS, and JavaScript frontend.

## Run locally

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python app.py
```

Open http://127.0.0.1:5000 in your browser.

## Simulation data

`facilities.json` defines facility footprints and operating rules; `resources.json` defines resource units and carrying metadata. `NewGame.json` is the default new-game template.

## Starting and saving games

On every browser launch or refresh, choose **New Game (Default)** or **Load Game**. New Game starts from `NewGame.json`; Load Game lists named snapshots and compatible legacy game files. During play, use **New Game** or **Load Game** beside the save controls to reopen the chooser. Time pauses while choosing; **Return to Game** or Escape resumes your selected speed. Save any progress you want to keep before switching.

- **Save** asks for a name the first time, then updates the current saved snapshot.
- **Save As...** asks for a name and creates a separate snapshot, preserving the previous save. Duplicate display names are allowed and remain separate files.
- Named snapshots live in `saves/` and survive app restarts. They include simulation time, facilities, inventories, crops, and queued work.
- Playing uses `ActiveGame.json` as a working copy. Named snapshots change only when you explicitly save; loading a snapshot restores that saved point.

Use the simulation speed selector to pause or change speed, or **Next Day** to advance one day. Manage Contents pauses time until its window closes.
