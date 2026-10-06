# Agent Qoidalari va Ko'rsatmalari

## Git Workflow
- Har bir vazifa yoki o'zgarish yakunlangach, oxirida avtomatik tarzda:
  1. `node tests/smoke.js` orqali testlarni tekshirish.
  2. Barcha yangi o'zgarishlarni qo'shish: `git add .`
  3. Qilingan ishga mos aniq commit xabari bilan commit qilish: `git commit -m "..."`
  4. GitHub ga push qilish: `git push origin main`
- Har qanday kod o'zgarishidan so'ng GitHub ga push qilinishi shart!
