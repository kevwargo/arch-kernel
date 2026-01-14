import {
  CustomResource,
  Duration,
  IgnoreMode,
  RemovalPolicy,
} from "aws-cdk-lib";
import {
  IVpc,
  KeyPair,
  Peer,
  Port,
  SecurityGroup,
  UserData,
} from "aws-cdk-lib/aws-ec2";
import {
  InstanceProfile,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Code, Function, LoggingFormat, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { Provider } from "aws-cdk-lib/custom-resources";
import { pascalCase } from "change-case";
import { Construct } from "constructs";

export interface CustomImageProps {
  vpc: IVpc;
  sourceImageId: string;
  commands: string[];
  size?: number;
}

export class CustomImage extends Construct {
  public readonly imageId: string;

  constructor(scope: Construct, id: string, props: CustomImageProps) {
    super(scope, id);

    const logGroup = new LogGroup(this, "LogGroup", {
      removalPolicy: RemovalPolicy.RETAIN,
      retention: RetentionDays.ONE_MONTH,
    });

    const secGroup = new SecurityGroup(this, "SecurityGroup", {
      vpc: props.vpc,
      allowAllIpv6Outbound: true,
      allowAllOutbound: true,
    });

    const instanceRole = new Role(this, "InstanceRole", {
      assumedBy:
        ServicePrincipal.fromStaticServicePrincipleName("ec2.amazonaws.com"),
    });
    instanceRole.addToPolicy(
      new PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: ["*"],
        conditions: {
          StringLike: { "aws:UserId": "*:${ec2:InstanceID}" },
        },
      }),
    );
    const instanceProfile = new InstanceProfile(this, "InstanceProfile", {
      role: instanceRole,
    });

    const createHandlerFn = (handler: string, ...policy: PolicyStatement[]) =>
      new Function(this, `${pascalCase(handler)}Handler`, {
        runtime: Runtime.PYTHON_3_13,
        handler: `handler.${handler}`,
        code: Code.fromAsset(__dirname, {
          exclude: ["*", "!handler.py"],
          ignoreMode: IgnoreMode.GIT,
        }),
        timeout: Duration.minutes(15),
        initialPolicy: policy,
        logGroup: logGroup,
        loggingFormat: LoggingFormat.JSON,
      });

    const provider = new Provider(this, "Provider", {
      onEventHandler: createHandlerFn(
        "on_event",
        new PolicyStatement({
          actions: [
            "ec2:RunInstances",
            "ec2:DescribeInstances",
            "ec2:TerminateInstances",
            "ec2:CreateTags",
          ],
          resources: ["*"],
        }),
        new PolicyStatement({
          actions: ["iam:PassRole"],
          resources: [instanceRole.roleArn],
        }),
      ),
      isCompleteHandler: createHandlerFn(
        "is_complete",
        new PolicyStatement({
          actions: ["ec2:DescribeInstances", "ec2:CreateImage"],
          resources: ["*"],
        }),
      ),
      logGroup,
    });

    const userData = UserData.forLinux();
    userData.addCommands(...props.commands);
    userData.addOnExitCommands(
      "TOKEN=`curl -X PUT http://169.254.169.254/latest/api/token -H X-aws-ec2-metadata-token-ttl-seconds:21600`",
      "INSTANCE_ID=`curl -H X-aws-ec2-metadata-token:$TOKEN http://169.254.169.254/latest/meta-data/instance-id`",
      "aws ec2 create-tags --resources $INSTANCE_ID --tags Key=image-build-exit-code,Value=$exitCode",
    );

    const imageProps: { [key: string]: any } = {
      SecurityGroupId: secGroup.securityGroupId,
      SourceImageId: props.sourceImageId,
      RootVolumeSize: props.size,
      InstanceProfileArn: instanceProfile.instanceProfileArn,
      UserData: userData.render(),
    };

    const publicKey = this.node.tryGetContext("debug-ssh-public-key");
    if (publicKey) {
      imageProps.KeyName = new KeyPair(this, "KeyPair", {
        publicKeyMaterial: publicKey,
      }).keyPairName;
      secGroup.addIngressRule(Peer.anyIpv4(), Port.SSH);
    }

    const image = new CustomResource(this, "Image", {
      resourceType: "Custom::EC2Image",
      serviceToken: provider.serviceToken,
      properties: imageProps,
    });
    this.imageId = image.getAttString("ImageId");
  }
}
