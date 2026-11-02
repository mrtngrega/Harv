# Test plan: {{clone's name}}

Build: {{commit}}  Date: {{YYYY-MM-DD}}  Target: {{dev server / Tauri window / phone}}, seed data

| case | flow | type | steps | expected | auto | result |
| --- | --- | --- | --- | --- | --- | --- |
| F01-H1 | write and save a letter | happy | new document, type a paragraph, bold a word, save as letter.docx | file saved, reopens with the bold word | e2e | |
| F01-E1 | | edge: close with unsaved changes | | asks to save, nothing lost | e2e | |
| F01-N1 | | negative: save to a read-only folder | | clear message, the text still there | manual | |
