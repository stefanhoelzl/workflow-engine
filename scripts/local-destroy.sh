#!/usr/bin/env bash
set -uo pipefail

CLUSTER_NAME="workflow-engine-dev"
CONTAINER_NAME="${CLUSTER_NAME}-control-plane"
IMAGE_NAME="localhost/workflow-engine:dev"
INFRA_DIR="infrastructure/local"
KUBECONFIG_PATH="/tmp/${CLUSTER_NAME}-kubeconfig"
IMAGE_ID_PATH="infrastructure/modules/image/local/.image-id"

# 2. Force-remove the kind cluster container
if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
  echo "Removing stale podman container: $CONTAINER_NAME"
  podman rm -f "$CONTAINER_NAME"
fi

# 3. Remove the podman image
if podman image exists "$IMAGE_NAME" 2>/dev/null; then
  echo "Removing podman image: $IMAGE_NAME"
  podman rmi -f "$IMAGE_NAME"
fi

# 4. Wipe tofu state
for f in "$INFRA_DIR/terraform.tfstate" "$INFRA_DIR/terraform.tfstate.backup"; do
  if [ -f "$f" ]; then
    echo "Removing $f"
    rm "$f"
  fi
done

# 5. Remove kubeconfig
if [ -f "$KUBECONFIG_PATH" ]; then
  echo "Removing $KUBECONFIG_PATH"
  rm "$KUBECONFIG_PATH"
fi

# 6. Remove .image-id
if [ -f "$IMAGE_ID_PATH" ]; then
  echo "Removing $IMAGE_ID_PATH"
  rm "$IMAGE_ID_PATH"
fi

echo "Local environment destroyed."
