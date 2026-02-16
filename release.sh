#!/bin/bash

PRE_RELEASE=$1

if [[ -z "$PRE_RELEASE" ]]; then
    PRE_RELEASE=false
fi

# Check for any uncommitted changes (unstaged or staged)
if [[ $(git status --porcelain) ]]; then
    echo "There are uncommitted changes. Please commit or stash them before running this script."
    exit 1
fi

# version
if [[ "$PRE_RELEASE" == true ]]; then
    VERSION=$(npm version prerelease --preid=beta)
else
    VERSION=$(npm version)
fi

# push the changes
git push origin main --follow-tags