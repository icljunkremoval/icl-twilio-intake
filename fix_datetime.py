import re

with open('/Users/icl-agent/icl-twilio-intake/db.js', 'r') as f:
    code = f.read()

# Replace the prepare shim to add datetime fix
old = "const pgSql = sql.replace(/\\?/g, () => `$${++i}`);"
new = "const pgSql = sql.replace(/datetime\\('now'\\)/gi, 'NOW()').replace(/\\?/g, () => `$${++i}`);"

code = code.replace(old, new)

with open('/Users/icl-agent/icl-twilio-intake/db.js', 'w') as f:
    f.write(code)

print("Done. Replacements made:", code.count("NOW()"))
