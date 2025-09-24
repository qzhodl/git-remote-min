 # Launch server
  - python3 -m venv myenv
  - source ./myenv/bin/active
  - pip install flask 
  - python3 server.py

# Link the git remote helper
  - cd git-remote-min
  - npm i
  - npm link

# Test in a project
## Create a local project
  - mk demo
  - echo "this is a test" > test.txt
  - git init
  - git add .
  - git commit -m "first"

## Push to the remote
  - git remote add origin min://localhost:8080/myrepo
  - git push -u origin main

## Clone the repo from remote
  - git clone min://localhost:8080/myrepo demo2  