import json
from datetime import UTC, datetime
from typing import Iterator
from uuid import uuid4

import boto3
from botocore.exceptions import ClientError

TAG_RESOURCE_ID = "image-build-custom-resource-id"
FIELD_INSTANCE_ID = "SourceInstanceId"

ec2 = boto3.client("ec2")


def on_create(event):
    resource_id = str(uuid4())
    props = event["ResourceProperties"]
    log(f"on_create: generated new resource ID {resource_id}", props=props)

    params = dict(
        ImageId=props["SourceImageId"],
        MinCount=1,
        MaxCount=1,
        InstanceType="t3.small",
        SecurityGroupIds=[props["SecurityGroupId"]],
        IamInstanceProfile={"Arn": props["InstanceProfileArn"]},
        UserData=props["UserData"],
        MetadataOptions={"HttpTokens": "optional"},
        TagSpecifications=[
            {
                "ResourceType": "instance",
                "Tags": [
                    {
                        "Key": "Name",
                        "Value": f'image-build-{props["Name"]}',
                    },
                    {
                        "Key": TAG_RESOURCE_ID,
                        "Value": resource_id,
                    },
                ],
            },
        ],
    )

    if size := props.get("RootVolumeSize"):
        params["BlockDeviceMappings"] = [
            {
                "DeviceName": "/dev/xvda",
                "Ebs": {"VolumeSize": int(size)},
            }
        ]
    if key_name := props.get("KeyName"):
        params["KeyName"] = key_name

    try:
        instance = ec2.run_instances(**params)["Instances"][0]
        log("on_create: created EC2 instance", instance=instance, params=params)
    except Exception as e:
        log(f"on_create: failed to run instance: {type(e).__name__}({e})", params=params)
        raise

    return {
        "PhysicalResourceId": resource_id,
        FIELD_INSTANCE_ID: instance["InstanceId"],
    }


def on_update(event):
    return {"PhysicalResourceId": event["PhysicalResourceId"]}


def on_delete(event):
    resource_id = event["PhysicalResourceId"]

    terminate_instances = list(iter_alive_instances(resource_id))
    if terminate_instances:
        log("terminating leftover instances", instances=terminate_instances)
        ec2.terminate_instances(InstanceIds=[i["InstanceId"] for i in terminate_instances])

    return {"PhysicalResourceId": resource_id}


def is_create_complete(event):
    resource_id = event["PhysicalResourceId"]
    instance_id = event[FIELD_INSTANCE_ID]
    if resp := handle_image_state(resource_id, instance_id):
        # The image has at least started creating.
        return resp

    if not ensure_instance_ready(instance_id):
        log(f"instance {instance_id} for {resource_id} is not ready yet")
        return {"IsComplete": False}

    # At this point the instance is done initializing and entered "stopped" state.
    create_image(event, instance_id)

    return {"IsComplete": False}


def handle_image_state(resource_id: str, instance_id: str | None = None) -> dict | None:
    resp = ec2.describe_images(
        Filters=[{"Name": f"tag:{TAG_RESOURCE_ID}", "Values": [resource_id]}]
    )
    if not ((images := resp.get("Images")) and (image := images[0])):
        log(f"image for {resource_id} does not exist")
        return None

    log("image exists", image=image)
    image_id, state = image["ImageId"], image["State"]
    if state in ("pending", "transient"):
        return {"IsComplete": False}
    if state == "available":
        if instance_id:
            # We don't need the instance anymore once the image has been successfully created.
            ec2.terminate_instances(InstanceIds=[instance_id])

        return {"IsComplete": True, "Data": {"ImageId": image_id}}

    raise ValueError(f"invalid state {state} for image {image_id}")


def ensure_instance_ready(instance_id: str) -> bool:
    log("checking instance status", instance_id=instance_id)

    try:
        instance = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"][0][
            "Instances"
        ][0]
    except (KeyError, IndexError, TypeError) as e:
        raise ValueError(f"Cannot find instance {instance_id}: {type(e).__name__}({e})") from e

    tags = {t["Key"]: t["Value"] for t in instance.get("Tags") or []}
    if (code := tags.get("image-build-exit-code")) is None:
        return False
    if code != "0":
        raise ValueError(f"Instance script failed with error code {code}")

    if (state := instance["State"]["Name"]) == "stopped":
        return True
    if state == "stopping":
        return False
    if state == "running":
        ec2.stop_instances(InstanceIds=[instance_id])
        return False

    reason = instance.get("StateReason") or ""
    raise ValueError(f"invalid state {state} ({reason}) for {instance_id}")


def create_image(event, instance_id):
    image_name = event["ResourceProperties"]["Name"]
    try:
        resp = ec2.create_image(
            InstanceId=instance_id,
            Name=image_name,
            TagSpecifications=[
                {
                    "ResourceType": res_type,
                    "Tags": [
                        {
                            "Key": TAG_RESOURCE_ID,
                            "Value": event["PhysicalResourceId"],
                        }
                    ],
                }
                for res_type in ("image", "snapshot")
            ],
        )
        log("initiated image creation", resp=resp)
    except ClientError as ce:
        if ce.response["Error"]["Code"] != "InvalidAMIName.Duplicate":
            raise
        log(f"waiting for image name {image_name!r} to become available")


def is_update_complete(event):
    # resp = {"IsComplete": True}
    # if "Data" in event:
    #     resp["Data"] = event["Data"]
    return handle_image_state(event["PhysicalResourceId"])


def is_delete_complete(event):
    is_complete = True
    for instance in iter_alive_instances(event["PhysicalResourceId"]):
        is_complete = False
        log("leftover instance is still alive", instance=instance)

    return {"IsComplete": is_complete}


def iter_alive_instances(resource_id: str) -> Iterator[dict]:
    for page in ec2.get_paginator("describe_instances").paginate(
        Filters=[{"Name": f"tag:{TAG_RESOURCE_ID}", "Values": [resource_id]}]
    ):
        for res in page["Reservations"]:
            for instance in res["Instances"]:
                if instance["State"]["Name"] not in ("shutting-down", "terminated"):
                    yield instance


def on_event(event, _):
    log("Handler: on_event", event=event)

    return {
        "Create": on_create,
        "Update": on_update,
        "Delete": on_delete,
    }[
        event["RequestType"]
    ](event)


def is_complete(event, _):
    log("Handler: is_complete", event=event)

    return {
        "Create": is_create_complete,
        "Update": is_update_complete,
        "Delete": is_delete_complete,
    }[event["RequestType"]](event)


def log(msg: str, **fields):
    print(json.dumps({"msg": msg, "time": datetime.now(UTC), **fields}, default=str))
