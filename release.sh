#!/bin/bash

TYPE=$1
PRE_RELEASE=${2:-false}

# Check if type is valid
if [[ "$TYPE" != "major" && "$TYPE" != "minor" && "$TYPE" != "patch" ]]; then
    echo "Usage: $0 <major|minor|patch> [pre-release]"
    exit 1
fi

# Check if pre-release is valid
if [[ $# -eq 2 && "$PRE_RELEASE" != "true" && "$PRE_RELEASE" != "false" ]]; then
    echo "Usage: $0 <major|minor|patch> [pre-release]"
    exit 1
fi

# Check if on main branch
if [[ $(git branch --show-current) != "main" ]]; then
    echo "You are not on the main branch. Please switch to the main branch before running this script."
    exit 1
fi

# Check for any uncommitted changes (unstaged or staged)
if [[ $(git status --porcelain) ]]; then
    echo "There are uncommitted changes. Please commit or stash them before running this script."
    exit 1
fi

# Check if not on main
if [[ $(git branch --show-current) != "main" ]]; then
    echo "You are not on the main branch. Please switch to the main branch before running this script."
    exit 1
fi

# Pull latest changes
git pull origin main

# strip prerelease tag before computing bump so patch goes 1.3.7-beta.0 -> 1.3.8
CURRENT=$(npm pkg get version | tr -d '"')
BASE=$(echo "$CURRENT" | sed 's/-.*//')
if [[ "$CURRENT" != "$BASE" ]]; then
    npm version "$BASE" --no-git-tag-version > /dev/null
fi

# npm version
if [[ "$PRE_RELEASE" == "true" ]]; then
    VERSION=$(npm version pre$TYPE --preid=beta --no-git-tag-version)
else
    VERSION=$(npm version $TYPE --no-git-tag-version)
fi
git reset --hard HEAD

# ask for confirmation
read -p "Are you sure you want to release version $VERSION? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborting..."
    exit 1
fi

# update version
npm version $VERSION